declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

import { LineDecision, matchLine } from '../shared/tagMatching';
import { FilterMode, Tag } from '../shared/tag';
import { scrollReducer, ScrollState } from '../shared/scrollState';
import { formatTimestamp } from '../shared/timestamp';
import { BAUD_RATE_PRESETS } from '../shared/baudPresets';

const vscode = acquireVsCodeApi();

const portSelect = document.getElementById('port') as HTMLSelectElement;
const baudInput = document.getElementById('baud') as HTMLInputElement;
const dataBitsSelect = document.getElementById('data-bits') as HTMLSelectElement;
const paritySelect = document.getElementById('parity') as HTMLSelectElement;
const stopBitsSelect = document.getElementById('stop-bits') as HTMLSelectElement;
const lineEndingSelect = document.getElementById('line-ending') as HTMLSelectElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const addMonitorBtn = document.getElementById('add-monitor') as HTMLButtonElement;
const tagBtn = document.getElementById('create-tag') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const tagsRow = document.getElementById('tags-row') as HTMLDivElement;
const panesArea = document.getElementById('panes') as HTMLDivElement;
const openLogFileBtn = document.getElementById('open-log-file') as HTMLButtonElement;
const logDirBtn = document.getElementById('log-dir') as HTMLButtonElement;
const baudToggleBtn = document.getElementById('baud-toggle') as HTMLButtonElement;
const baudMenu = document.getElementById('baud-menu') as HTMLDivElement;
const timestampsBtn = document.getElementById('timestamps') as HTMLButtonElement;
const filterToggleBtn = document.getElementById('filter-toggle') as HTMLButtonElement;
const filterMenu = document.getElementById('filter-menu') as HTMLDivElement;
const collapseHwBtn = document.getElementById('collapse-hw') as HTMLButtonElement;
const hwRow = document.getElementById('hw-row') as HTMLDivElement;
const manageToggleBtn = document.getElementById('manage-toggle') as HTMLButtonElement;
const managePanel = document.getElementById('manage-panel') as HTMLDivElement;

/** Per-pane DOM. Every pane is self-contained: header actions, console with
 * find widget and marks strip, and a port-local send bar. */
interface PaneDom {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  title: HTMLSpanElement;
  play: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  logBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  scrollBtn: HTMLButtonElement;
  findBtn: HTMLButtonElement;
  close: HTMLSpanElement;
  log: HTMLDivElement;
  marks: HTMLDivElement;
  findBar: HTMLDivElement;
  findInput: HTMLInputElement;
  findCase: HTMLButtonElement;
  findWord: HTMLButtonElement;
  findRegex: HTMLButtonElement;
  findCount: HTMLSpanElement;
  findPrev: HTMLButtonElement;
  findNext: HTMLButtonElement;
  findClose: HTMLButtonElement;
  sendRow: HTMLDivElement;
  sendInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  /** Per-pane virtualization spacers. They MUST NOT be shared: replaceChildren
   * moves nodes, so a module-level pair would be stolen by whichever pane
   * rendered last, collapsing the other pane's scrollable height. */
  spacerTop: HTMLDivElement;
  spacerBottom: HTMLDivElement;
  /** Overlay hint shown when the pane has no lines yet (connecting/waiting/stopped). */
  hint: HTMLDivElement;
  /** Secondary overview strip showing where find matches sit in the buffer. */
  findMarks: HTMLDivElement;
}

/** One occurrence of the find query inside a line's rendered text. */
interface FindOccurrence {
  lineIndex: number;
  start: number;
  end: number;
}

interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  error: boolean;
  occurrences: FindOccurrence[];
  /** occurrence index → line, for the current-match highlight and jumps */
  current: number;
  byLine: Map<number, FindOccurrence[]>;
  debounce: number | undefined;
}

/** Per-pane port settings captured at creation, so a stopped pane can be
 * restarted independently of whatever the hardware row currently shows. */
interface PortSettings {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
}

/**
 * One split-view pane's worth of state. Ports and opened log files are both
 * sessions: a port session streams from its controller, a file session is a
 * read-only snapshot. Buffers, scroll position, connection state,
 * log-to-file, send bar, and find are per session; tags, filter mode, and
 * timestamps are global display choices.
 */
interface TabSession {
  id: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  message?: string;
  settings?: PortSettings;
  lineStore: { text: string; ts?: number }[];
  decisions: LineDecision[];
  visibleIndexes: number[];
  scroll: ScrollState;
  scrollTop: number;
  logDesired: boolean;
  logFile?: string;
  logDirectory?: string;
  find: FindState;
  dom: PaneDom;
  lastRender?: { topPx: number; bottomPx: number; rows: RenderedRow[] };
  marksDirty: boolean;
  /** Divider element on this pane's left edge (undefined for the first pane);
   * dragging it resizes the pane. */
  dividerLeft?: HTMLDivElement;
  /** Per-pane send history for ArrowUp/ArrowDown recall. */
  sendHistory: string[];
  sendIndex: number;
  sendDraft: string;
}

const sessions: TabSession[] = [];
let focusedId: number | undefined;
// When Start replaces an idle session on the same port, the old pane closes
// only after the new session actually connects (a failed open keeps it).
let pendingReplaceId: number | undefined;

// Display-layer globals shared by every pane.
let filterMode: FilterMode = 'off';
let showTimestamps = false;
let tags: Tag[] = [];
let recentBauds: number[] = [];

function focusedSession(): TabSession | undefined {
  return sessions.find((s) => s.id === focusedId);
}

// Virtualized rendering: fixed-height rows, spacer divs hold the scrolled
// distance so only the visible window (plus overscan) exists in the DOM.
const OVERSCAN_ROWS = 20;
let rowHeightPx = 20;
const pendingRenders = new Set<TabSession>();
let renderScheduled = false;

// CSS Custom Highlight API (Chromium ≥105, guaranteed in VS Code's webview);
// guarded lookups keep TypeScript's DOM lib happy.
type HighlightLike = { new (...ranges: Range[]): unknown };
const highlightCtor = (window as unknown as { Highlight?: HighlightLike }).Highlight;
const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

function measureRowHeight(logEl: HTMLElement): void {
  const probe = document.createElement('div');
  probe.className = 'row-line';
  probe.style.visibility = 'hidden';
  probe.textContent = 'X';
  logEl.appendChild(probe);
  rowHeightPx = probe.offsetHeight || 20;
  probe.remove();
}

function renderText(entry: { text: string; ts?: number }): string {
  if (showTimestamps && entry.ts !== undefined) {
    return `[${formatTimestamp(entry.ts)}] ${entry.text}`;
  }
  return entry.text;
}

function renderWindowFor(s: TabSession): void {
  pendingRenders.delete(s);
  const logEl = s.dom.log;
  const total = s.visibleIndexes.length;
  const first = Math.max(0, Math.floor(logEl.scrollTop / rowHeightPx) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((logEl.scrollTop + logEl.clientHeight) / rowHeightPx) + OVERSCAN_ROWS);

  const rows: RenderedRow[] = [];
  for (let p = first; p < last; p++) {
    const lineIndex = s.visibleIndexes[p];
    const colors = s.decisions[lineIndex].highlightColors;
    rows.push({
      lineIndex,
      text: renderText(s.lineStore[lineIndex]),
      bg: colors.length ? `${colors[0]}45` : '',
      bgImage: colorBar(colors),
      textIndent: colors.length > 1 ? '10px' : '',
    });
  }
  const topPx = first * rowHeightPx;
  const bottomPx = (total - last) * rowHeightPx;

  // Skip the DOM swap entirely when the rendered window is unchanged — a
  // streaming append below the viewport must not destroy a text selection.
  const prev = s.lastRender;
  if (
    prev &&
    prev.topPx === topPx &&
    prev.bottomPx === bottomPx &&
    prev.rows.length === rows.length &&
    prev.rows.every(
      (r, i) =>
        r.lineIndex === rows[i].lineIndex &&
        r.text === rows[i].text &&
        r.bg === rows[i].bg &&
        r.bgImage === rows[i].bgImage &&
        r.textIndent === rows[i].textIndent,
    )
  ) {
    renderMarksFor(s);
    renderFindMarksFor(s);
    refreshFindHighlights();
    return;
  }

  const savedSelection = captureSelection();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row-line';
    row.dataset.lineIndex = String(r.lineIndex);
    row.textContent = r.text;
    row.style.background = r.bg;
    row.style.backgroundImage = r.bgImage;
    row.style.textIndent = r.textIndent;
    frag.appendChild(row);
  }
  s.dom.spacerTop.style.height = `${topPx}px`;
  s.dom.spacerBottom.style.height = `${bottomPx}px`;
  s.dom.log.replaceChildren(s.dom.spacerTop, frag, s.dom.spacerBottom);
  restoreSelection(savedSelection);
  s.lastRender = { topPx, bottomPx, rows };
  renderMarksFor(s);
  renderFindMarksFor(s);
  refreshFindHighlights();
}

/** Multi-match color bar: one 5px segment per matching tag, so overlapping
 * tags stay visible instead of masking each other. */
function colorBar(colors: string[]): string {
  if (colors.length < 2) {
    return '';
  }
  const stops = colors.map((c, i) => `${c} ${i * 5}px ${(i + 1) * 5}px`).join(', ');
  return `linear-gradient(to right, ${stops}, transparent ${colors.length * 5}px)`;
}

interface RenderedRow {
  lineIndex: number;
  text: string;
  bg: string;
  bgImage: string;
  textIndent: string;
}

/** Overview strip beside a pane's scrollbar: one block per tag-highlighted
 * line, squashed to the viewport like the editor's overview ruler.
 * Positions live in filtered (visible) row space so they track what the
 * scrollbar shows. */
function renderMarksFor(s: TabSession): void {
  if (!s.marksDirty) {
    return;
  }
  s.marksDirty = false;
  const total = s.visibleIndexes.length;
  const height = Math.max(1, s.dom.log.clientHeight - 8); // the strip insets 4px top/bottom
  const buckets = new Map<number, string>();
  for (let p = 0; p < total; p++) {
    const colors = s.decisions[s.visibleIndexes[p]].highlightColors;
    if (colors.length) {
      const row = Math.min(height - 1, Math.floor((p / total) * height));
      if (!buckets.has(row)) {
        buckets.set(row, colors[0]);
      }
    }
  }
  s.dom.marks.textContent = '';
  if (!buckets.size) {
    s.dom.marks.style.display = 'none';
    return;
  }
  for (const [row, color] of buckets) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.top = `${row}px`;
    mark.style.background = color;
    s.dom.marks.appendChild(mark);
  }
  s.dom.marks.style.display = 'block';
}

/** Find-match ticks in the secondary overview strip: where the current
 * query hits sit inside the buffer, squashed like the tag marks. */
function renderFindMarksFor(s: TabSession): void {
  const f = s.find;
  const strip = s.dom.findMarks;
  const total = s.visibleIndexes.length;
  if (!f.open || !f.occurrences.length || !total) {
    strip.textContent = '';
    strip.style.display = 'none';
    return;
  }
  const height = Math.max(1, s.dom.log.clientHeight - 8);
  const posOf = new Map<number, number>();
  for (let p = 0; p < total; p++) {
    posOf.set(s.visibleIndexes[p], p);
  }
  const buckets = new Map<number, number>(); // row → first occurrence index
  for (let i = 0; i < f.occurrences.length; i++) {
    const p = posOf.get(f.occurrences[i].lineIndex);
    if (p === undefined) {
      continue;
    }
    const row = Math.min(height - 1, Math.floor((p / total) * height));
    if (!buckets.has(row)) {
      buckets.set(row, i);
    }
  }
  strip.textContent = '';
  for (const [row, occIndex] of buckets) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.top = `${row}px`;
    tick.dataset.occ = String(occIndex);
    strip.appendChild(tick);
  }
  strip.style.display = 'block';
}

// --- Find (editor-style widget, per pane) ------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFindRegex(f: FindState): RegExp | undefined {
  try {
    let source = f.regex ? f.query : escapeRegExp(f.query);
    if (f.wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    return new RegExp(source, f.matchCase ? 'g' : 'gi');
  } catch {
    return undefined; // invalid regex source: reported as "Bad pattern"
  }
}

/** Recomputes a pane's find occurrences over its VISIBLE lines (filter is
 * respected) in rendered-text coordinates, so ranges land on the row text
 * nodes exactly as displayed. */
function recomputeOccurrences(s: TabSession): void {
  const f = s.find;
  f.occurrences = [];
  f.byLine = new Map();
  f.error = false;
  if (f.open && f.query) {
    const re = buildFindRegex(f);
    if (!re) {
      f.error = true;
    } else {
      for (const lineIndex of s.visibleIndexes) {
        const text = renderText(s.lineStore[lineIndex]);
        let m: RegExpExecArray | null;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 1000) {
          if (m[0].length === 0) {
            re.lastIndex++; // never let an empty match loop forever
            continue;
          }
          const occ: FindOccurrence = { lineIndex, start: m.index, end: m.index + m[0].length };
          f.occurrences.push(occ);
          let list = f.byLine.get(lineIndex);
          if (!list) {
            list = [];
            f.byLine.set(lineIndex, list);
          }
          list.push(occ);
        }
      }
      if (f.current >= f.occurrences.length) {
        f.current = f.occurrences.length ? f.occurrences.length - 1 : 0;
      }
    }
  }
  renderFindCount(s);
  renderFindMarksFor(s);
  refreshFindHighlights();
}

function renderFindCount(s: TabSession): void {
  const f = s.find;
  const el = s.dom.findCount;
  el.classList.toggle('error', f.error);
  if (f.error) {
    el.textContent = 'Bad pattern';
  } else if (!f.query) {
    el.textContent = '';
  } else if (!f.occurrences.length) {
    el.textContent = 'No results';
  } else {
    el.textContent = `${Math.min(f.current + 1, f.occurrences.length)} of ${f.occurrences.length}`;
  }
}

/** Scrolls the pane so the current occurrence's row sits mid-viewport. */
function jumpToCurrent(s: TabSession): void {
  const f = s.find;
  const occ = f.occurrences[f.current];
  if (!occ) {
    return;
  }
  const p = s.visibleIndexes.indexOf(occ.lineIndex);
  if (p >= 0) {
    s.dom.log.scrollTop = Math.max(0, p * rowHeightPx - s.dom.log.clientHeight / 2);
  }
}

function navigateFind(s: TabSession, dir: 1 | -1): void {
  const f = s.find;
  if (!f.occurrences.length) {
    return;
  }
  f.current = (f.current + dir + f.occurrences.length) % f.occurrences.length;
  jumpToCurrent(s);
  renderFindCount(s);
  refreshFindHighlights();
}

/** Rebuilds the document-level match highlights from every pane's rendered
 * rows. Text-level ranges mean the selection machinery stays untouched. */
function refreshFindHighlights(): void {
  if (!highlightCtor || !highlightRegistry) {
    return;
  }
  const ranges: Range[] = [];
  const current: Range[] = [];
  for (const s of sessions) {
    if (!s.find.open || !s.find.occurrences.length) {
      continue;
    }
    for (const row of Array.from(s.dom.log.querySelectorAll('.row-line'))) {
      const lineIndex = Number((row as HTMLElement).dataset.lineIndex);
      const textNode = row.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        continue;
      }
      for (const occ of s.find.byLine.get(lineIndex) ?? []) {
        const range = document.createRange();
        range.setStart(textNode, occ.start);
        range.setEnd(textNode, occ.end);
        ranges.push(range);
        if (s.find.occurrences[s.find.current] === occ) {
          current.push(range);
        }
      }
    }
  }
  if (ranges.length) {
    highlightRegistry.set('sm-find', new highlightCtor(...ranges));
  } else {
    highlightRegistry.delete('sm-find');
  }
  if (current.length) {
    highlightRegistry.set('sm-find-cur', new highlightCtor(...current));
  } else {
    highlightRegistry.delete('sm-find-cur');
  }
}

function openFind(s: TabSession): void {
  s.find.open = true;
  s.dom.findBar.classList.add('visible');
  s.dom.findInput.focus();
  s.dom.findInput.select();
  recomputeOccurrences(s);
}

function closeFind(s: TabSession): void {
  s.find.open = false;
  s.find.query = '';
  s.dom.findInput.value = '';
  s.dom.findBar.classList.remove('visible');
  recomputeOccurrences(s);
}

function scheduleFindRecompute(s: TabSession): void {
  if (s.find.debounce !== undefined) {
    clearTimeout(s.find.debounce);
  }
  s.find.debounce = setTimeout(() => {
    s.find.debounce = undefined;
    recomputeOccurrences(s);
  }, 150) as unknown as number;
}

interface SelectionPoint {
  line: number;
  off: number;
}

function captureSelection(): { start: SelectionPoint; end: SelectionPoint } | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return undefined;
  }
  const range = sel.getRangeAt(0);
  const start = locateSelectionBoundary(range.startContainer, range.startOffset);
  const end = locateSelectionBoundary(range.endContainer, range.endOffset);
  return start && end ? { start, end } : undefined;
}

function locateSelectionBoundary(node: Node | null, offset: number): SelectionPoint | undefined {
  const row = (node instanceof Element ? node : node?.parentElement)?.closest('.row-line') as HTMLElement | null;
  if (!row || row.dataset.lineIndex === undefined) {
    return undefined;
  }
  const off = node && node.nodeType === Node.TEXT_NODE ? offset : offset === 0 ? 0 : (row.textContent?.length ?? 0);
  return { line: Number(row.dataset.lineIndex), off };
}

function restoreSelection(saved?: { start: SelectionPoint; end: SelectionPoint }): void {
  if (!saved) {
    return;
  }
  const findRow = (line: number) => panesArea.querySelector(`.row-line[data-line-index="${line}"]`);
  const startRow = findRow(saved.start.line);
  const endRow = findRow(saved.end.line);
  if (!startRow || !endRow) {
    return; // the selection scrolled out of the rendered window
  }
  const range = new Range();
  const startText = startRow.childNodes[0] ?? startRow;
  const endText = endRow.childNodes[0] ?? endRow;
  range.setStart(startText, Math.min(saved.start.off, startRow.textContent?.length ?? 0));
  range.setEnd(endText, Math.min(saved.end.off, endRow.textContent?.length ?? 0));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function scheduleRender(s: TabSession): void {
  pendingRenders.add(s);
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    for (const pending of [...pendingRenders]) {
      renderWindowFor(pending);
    }
  });
}

function rebuildVisibleIndexes(s: TabSession): void {
  s.visibleIndexes = [];
  for (let i = 0; i < s.decisions.length; i++) {
    if (s.decisions[i].visible) {
      s.visibleIndexes.push(i);
    }
  }
}

function dropOldest(s: TabSession, count: number): void {
  if (count <= 0) {
    return;
  }
  s.lineStore.splice(0, count);
  s.decisions.splice(0, count);
  rebuildVisibleIndexes(s);
  s.marksDirty = true;
}

function appendToSession(s: TabSession, entries: { text: string; ts?: number }[], dropCount: number): void {
  dropOldest(s, dropCount);
  for (const entry of entries) {
    s.decisions.push(matchLine(entry.text, tags, filterMode));
    if (s.decisions[s.decisions.length - 1].visible) {
      s.visibleIndexes.push(s.lineStore.length);
    }
    s.lineStore.push(entry);
  }
  s.marksDirty = true;
  scheduleRender(s);
  if (s.find.open) {
    scheduleFindRecompute(s); // keep counts and highlights fresh while streaming
  }
  if (s.scroll === 'follow') {
    // Pin to the bottom after the window re-renders with the new content.
    requestAnimationFrame(() => {
      s.dom.log.scrollTop = s.dom.log.scrollHeight;
    });
  }
  refreshPaneControls(s);
}

/** Tags, filter mode, and timestamps are global: a change re-decides every
 * pane's lines, not just the focused one. */
function restyleAllRows(): void {
  for (const s of sessions) {
    for (let i = 0; i < s.lineStore.length; i++) {
      s.decisions[i] = matchLine(s.lineStore[i].text, tags, filterMode);
    }
    rebuildVisibleIndexes(s);
    s.marksDirty = true;
    scheduleRender(s);
    if (s.find.open) {
      scheduleFindRecompute(s);
    }
  }
}

function fillPorts(ports: { path: string; description?: string }[]): void {
  portSelect.textContent = '';
  if (!ports.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No serial ports detected';
    portSelect.appendChild(opt);
    portSelect.disabled = true;
    return;
  }
  portSelect.disabled = false; // several monitors can run; the picker stays open
  for (const p of ports) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.description ? `${p.path} - ${p.description}` : p.path;
    portSelect.appendChild(o);
  }
}

function updateButtons(): void {
  connectBtn.innerHTML = '&#9654; Start Monitoring';
  connectBtn.title = 'Start monitoring the selected port in a new pane';
  connectBtn.disabled = portSelect.value === '';
  portSelect.disabled = false;
  refreshBtn.disabled = false;
  updateTagButton();
}

function renderTimestampsControl(): void {
  timestampsBtn.classList.toggle('on', showTimestamps);
  timestampsBtn.title = `Timestamps: ${showTimestamps ? 'on' : 'off'} — click to ${showTimestamps ? 'hide' : 'show'} them`;
}

function updateTagButton(): void {
  const selected = window.getSelection()?.toString().trim() ?? '';
  tagBtn.disabled = selected.length === 0;
  tagBtn.title = selected
    ? `Create a tag from "${selected.length > 24 ? selected.slice(0, 24) + '…' : selected}"`
    : 'Create a tag from the selected text (or type one in the ⚙ panel)';
}

tagBtn.addEventListener('click', () => {
  const selected = window.getSelection()?.toString().trim() ?? '';
  if (!selected) {
    return;
  }
  vscode.postMessage({ type: 'createTag', pattern: selected });
});
// Keep the selection alive: clicking the button must not collapse it.
tagBtn.addEventListener('mousedown', (e) => e.preventDefault());

function setStatus(message?: string): void {
  if (message) {
    statusEl.textContent = message;
    return;
  }
  const f = focusedSession();
  if (f) {
    statusEl.textContent =
      f.message || (f.state === 'connected' ? 'Connected' : f.state === 'connecting' ? 'Connecting...' : 'Idle');
    return;
  }
  const live = sessions.filter((s) => s.kind === 'port' && s.state === 'connected').length;
  statusEl.textContent = live ? `${live} monitor${live > 1 ? 's' : ''} running` : 'Idle';
}

// --- Split-view panes --------------------------------------------------------

function syncEmptyState(): void {
  panesArea.querySelector('.log-empty')?.remove();
  if (sessions.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'log-empty';
    hint.textContent =
      'No monitors open — pick a port above and press Start Monitoring, or open a saved log file.';
    panesArea.appendChild(hint);
  }
}

/** Refreshes one pane's self-contained controls from its session state. */
function refreshPaneControls(s: TabSession): void {
  const d = s.dom;
  const isPort = s.kind === 'port';
  const isConnected = isPort && s.state === 'connected';

  d.dot.className = 'tab-dot' + (s.state === 'connected' ? ' live' : s.state === 'connecting' ? ' pending' : '');
  d.title.textContent = (s.kind === 'file' ? '\u{1F4C4} ' : '') + s.title;
  d.title.title = s.kind === 'file' ? `${s.title} (read-only log file)` : `${s.title} — ${s.state}`;
  d.root.title = d.title.title;

  d.play.style.display = isPort ? '' : 'none';
  d.play.innerHTML = isConnected ? '&#9632;' : '&#9654;';
  d.play.classList.toggle('on', isConnected);
  d.play.title = isConnected ? `Stop monitoring ${s.title}` : `Start monitoring ${s.title}`;
  d.play.disabled = s.state === 'connecting';

  d.clearBtn.disabled = s.lineStore.length === 0 && !isConnected;
  d.clearBtn.title = `Clear ${s.title}`;
  d.exportBtn.disabled = s.lineStore.length === 0;
  d.exportBtn.title = `Export ${s.title}'s buffered log to a file`;

  d.logBtn.style.display = isPort ? '' : 'none';
  const logOn = isPort && s.logDesired;
  d.logBtn.classList.toggle('on', logOn);
  d.logBtn.classList.toggle('rec', logOn);
  d.logBtn.innerHTML = logOn ? '&#128308;&#65039;' : '&#9898;&#65039;';
  if (!isPort) {
    d.logBtn.title = '';
  } else if (logOn) {
    const where = s.logFile ? ` (now: ${s.logFile})` : s.logDirectory ? ` into ${s.logDirectory}` : '';
    d.logBtn.title = `Log to file: on${where} — click to stop`;
  } else {
    d.logBtn.title = 'Log to file: off — click to log this session to a .log file';
  }

  d.scrollBtn.innerHTML = s.scroll === 'follow' ? '&#8681;' : '&#128274;';
  d.scrollBtn.classList.toggle('locked', s.scroll === 'locked');
  d.scrollBtn.title =
    s.scroll === 'follow'
      ? 'Viewport follows new lines — click to lock'
      : 'Scroll locked, data keeps arriving — click to rejoin';

  d.sendRow.style.display = isPort ? 'flex' : 'none';
  d.sendInput.disabled = !isConnected;
  d.sendBtn.disabled = !isConnected;
  d.sendInput.placeholder = isConnected ? `To ${s.title}: type a message to send...` : 'Start monitoring to send';

  // Empty-pane hint: connect/wait/stop states would otherwise look frozen.
  let hintText = '';
  if (isPort && s.lineStore.length === 0) {
    if (s.state === 'connecting') {
      hintText = `Connecting to ${s.title}…`;
    } else if (s.state === 'connected') {
      hintText = 'Waiting for data…';
    } else {
      hintText = 'Stopped — press ▶ to start monitoring';
    }
  }
  d.hint.style.display = hintText ? 'flex' : 'none';
  if (hintText) {
    d.hint.textContent = hintText;
  }
}

function buildPane(s: TabSession): PaneDom {
  const root = document.createElement('div');
  root.className = 'pane';

  // Header: status dot, title, port-local actions, close.
  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const title = document.createElement('span');
  title.className = 'pane-title';
  const mkBtn = (glyph: string, cls = '') => {
    const b = document.createElement('button');
    b.className = ('pbtn ' + cls).trim();
    b.innerHTML = glyph;
    return b;
  };
  const play = mkBtn('&#9654;');
  const clearBtn = mkBtn('&#129529;');
  const logBtn = mkBtn('&#9898;&#65039;');
  const exportBtn = mkBtn('&#128228;');
  const scrollBtn = mkBtn('&#8681;');
  const findBtn = mkBtn('&#128269;');
  findBtn.title = 'Find in this pane (Ctrl+F)';
  const close = document.createElement('span');
  close.className = 'pane-close';
  close.textContent = '\u00d7';
  close.title = 'Close this pane';
  header.append(dot, title, play, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close);

  // Body: console + marks strips + floating find widget + state hint.
  const body = document.createElement('div');
  body.className = 'pane-body';
  const logEl = document.createElement('div');
  logEl.className = 'pane-log';
  const marks = document.createElement('div');
  marks.className = 'log-marks';
  marks.title = 'Highlighted lines — click to jump';
  const findMarks = document.createElement('div');
  findMarks.className = 'find-marks';
  findMarks.title = 'Find matches — click to jump to the nearest one';
  const hint = document.createElement('div');
  hint.className = 'pane-hint';

  const findBar = document.createElement('div');
  findBar.className = 'find-bar';
  const findInput = document.createElement('input');
  findInput.placeholder = 'Find';
  findInput.spellcheck = false;
  const findCase = document.createElement('button');
  findCase.className = 'fbtn';
  findCase.textContent = 'Aa';
  findCase.title = 'Match case';
  const findWord = document.createElement('button');
  findWord.className = 'fbtn';
  findWord.textContent = 'ab';
  findWord.title = 'Match whole word';
  const findRegex = document.createElement('button');
  findRegex.className = 'fbtn';
  findRegex.textContent = '.*';
  findRegex.title = 'Use regular expression';
  const findCount = document.createElement('span');
  findCount.className = 'find-count';
  const findPrev = document.createElement('button');
  findPrev.className = 'fbtn';
  findPrev.innerHTML = '&#8593;';
  findPrev.title = 'Previous match (Shift+Enter)';
  const findNext = document.createElement('button');
  findNext.className = 'fbtn';
  findNext.innerHTML = '&#8595;';
  findNext.title = 'Next match (Enter)';
  const findClose = document.createElement('button');
  findClose.className = 'fbtn';
  findClose.innerHTML = '&#10005;';
  findClose.title = 'Close find (Escape)';
  findBar.append(findInput, findCase, findWord, findRegex, findCount, findPrev, findNext, findClose);
  body.append(logEl, marks, findMarks, findBar, hint);

  // Find-match strip: clicking at a height fraction jumps to the nearest
  // occurrence at or after that fraction of the buffer.
  findMarks.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = findMarks.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height)));
    const total = s.visibleIndexes.length;
    if (!total || !s.find.occurrences.length) {
      return;
    }
    const targetP = frac * total;
    let chosen = s.find.occurrences.length - 1;
    for (let i = 0; i < s.find.occurrences.length; i++) {
      const p = s.visibleIndexes.indexOf(s.find.occurrences[i].lineIndex);
      if (p >= targetP) {
        chosen = i;
        break;
      }
    }
    s.find.current = chosen;
    jumpToCurrent(s);
    renderFindCount(s);
    refreshFindHighlights();
  });

  // Port-local send bar.
  const sendRow = document.createElement('div');
  sendRow.className = 'pane-send';
  const sendInput = document.createElement('input');
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  sendRow.append(sendInput, sendBtn);

  root.append(header, body, sendRow);
  panesArea.appendChild(root);

  root.addEventListener('click', () => setFocused(s.id));

  close.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'closeSession', sessionId: s.id });
    removeSession(s.id);
  });

  play.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.state === 'connected') {
      vscode.postMessage({ type: 'disconnect', sessionId: s.id });
    } else if (s.state !== 'connecting') {
      startPane(s);
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind === 'port') {
      vscode.postMessage({ type: 'clear', sessionId: s.id }); // host resets its ring count too
    }
    clearBuffer(s);
  });

  logBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind !== 'port' || s.state === 'connecting') {
      return;
    }
    vscode.postMessage({ type: 'setLogSession', sessionId: s.id, enabled: !s.logDesired });
  });

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'export', sessionId: s.id });
  });

  scrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    s.scroll = scrollReducer(s.scroll, { type: 'toggle' });
    if (s.scroll === 'follow') {
      logEl.scrollTop = logEl.scrollHeight; // rejoining the stream snaps to the bottom
    }
    refreshPaneControls(s);
  });

  findBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.find.open) {
      closeFind(s);
    } else {
      setFocused(s.id);
      openFind(s);
    }
  });

  // The strip squashes the whole buffer to the viewport; clicking at a height
  // fraction jumps to the same fraction of the document.
  marks.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = marks.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    logEl.scrollTop = frac * (logEl.scrollHeight - logEl.clientHeight);
  });

  // Scroll Lock: user scrolls drive the follow/locked reducer; programmatic
  // pinning only ever scrolls to the bottom, which keeps Follow.
  logEl.addEventListener('scroll', () => {
    s.scrollTop = logEl.scrollTop;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const next = scrollReducer(s.scroll, { type: 'scrolled', atBottom });
    if (next !== s.scroll) {
      s.scroll = next;
      refreshPaneControls(s);
    }
    scheduleRender(s);
  });

  // Find widget wiring.
  findInput.addEventListener('input', () => {
    s.find.query = findInput.value;
    s.find.current = 0;
    scheduleFindRecompute(s);
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFind(s, e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateFind(s, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateFind(s, -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind(s);
      logEl.focus();
    }
    e.stopPropagation();
  });
  const wireToggle = (btn: HTMLButtonElement, key: 'matchCase' | 'wholeWord' | 'regex') => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      s.find[key] = !s.find[key];
      btn.classList.toggle('on', s.find[key]);
      s.find.current = 0;
      recomputeOccurrences(s);
    });
  };
  wireToggle(findCase, 'matchCase');
  wireToggle(findWord, 'wholeWord');
  wireToggle(findRegex, 'regex');
  findPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateFind(s, -1);
  });
  findNext.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateFind(s, 1);
  });
  findClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFind(s);
  });

  sendBtn.addEventListener('click', () => sendCurrent(s));
  sendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendCurrent(s);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!s.sendHistory.length) {
        return;
      }
      if (s.sendIndex === s.sendHistory.length) {
        s.sendDraft = sendInput.value; // remember the unsent draft
      }
      s.sendIndex = Math.max(0, s.sendIndex - 1);
      sendInput.value = s.sendHistory[s.sendIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (s.sendIndex >= s.sendHistory.length) {
        return;
      }
      s.sendIndex++;
      sendInput.value = s.sendIndex === s.sendHistory.length ? s.sendDraft : s.sendHistory[s.sendIndex];
    }
  });

  const spacerTop = document.createElement('div');
  spacerTop.className = 'log-spacer';
  const spacerBottom = document.createElement('div');
  spacerBottom.className = 'log-spacer';

  return { root, dot, title, play, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close, log: logEl, marks, findBar, findInput, findCase, findWord, findRegex, findCount, findPrev, findNext, findClose, sendRow, sendInput, sendBtn, spacerTop, spacerBottom, hint, findMarks };
}

function createSession(m: {
  sessionId: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  settings?: PortSettings;
}): TabSession {
  const isFirst = sessions.length === 0;
  const s: TabSession = {
    id: m.sessionId,
    kind: m.kind,
    title: m.title,
    state: m.state,
    settings: m.settings,
    lineStore: [],
    decisions: [],
    visibleIndexes: [],
    scroll: 'follow',
    scrollTop: 0,
    logDesired: false,
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
    marksDirty: true,
    dom: undefined as unknown as PaneDom,
    sendHistory: [],
    sendIndex: 0,
    sendDraft: '',
  };
  sessions.push(s);
  syncEmptyState();
  s.dom = buildPane(s);
  measureRowHeight(s.dom.log);
  if (!isFirst) {
    // Draggable divider on the pane's left edge; double-click resets to an
    // equal share.
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.addEventListener('mousedown', (e) => startPaneDrag(s, e));
    divider.addEventListener('dblclick', () => {
      s.dom.root.style.flexGrow = '';
    });
    panesArea.insertBefore(divider, s.dom.root);
    s.dividerLeft = divider;
  }
  refreshPaneControls(s);
  setFocused(s.id);
  return s;
}

/** Drag-resize: the divider adjusts the left pane's flex-grow weight 1:1
 * with the pointer. */
function startPaneDrag(s: TabSession, e: MouseEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = s.dom.root.getBoundingClientRect().width || 300;
  const startWeight = Number(s.dom.root.style.flexGrow) || 1;
  const pxPerWeight = startWidth / startWeight;
  document.body.classList.add('pane-dragging');
  const move = (ev: MouseEvent) => {
    const weight = Math.min(6, Math.max(0.35, startWeight + (ev.clientX - startX) / pxPerWeight));
    s.dom.root.style.flexGrow = String(weight);
  };
  const up = () => {
    document.body.classList.remove('pane-dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function setFocused(id: number | undefined): void {
  focusedId = id;
  for (const s of sessions) {
    s.dom.root.classList.toggle('focused', s.id === focusedId);
  }
  setStatus();
}

function removeSession(id: number): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return;
  }
  const [gone] = sessions.splice(idx, 1);
  if (gone.find.debounce !== undefined) {
    clearTimeout(gone.find.debounce);
  }
  gone.dom.root.remove();
  gone.dividerLeft?.remove();
  if (idx === 0 && sessions.length > 0) {
    // The next pane became the first: its left divider would dangle.
    sessions[0].dividerLeft?.remove();
    sessions[0].dividerLeft = undefined;
  }
  pendingRenders.delete(gone);
  if (pendingReplaceId === id) {
    pendingReplaceId = undefined;
  }
  if (focusedId === id) {
    const next = sessions[idx] ?? sessions[idx - 1];
    setFocused(next?.id);
  }
  if (sessions.length === 0) {
    syncEmptyState();
  }
  refreshFindHighlights();
}

/** Restarts (or starts) this pane's port using the settings captured at
 * creation — independent of the hardware row's current selection. */
function startPane(s: TabSession): void {
  const cfg = s.settings;
  pendingReplaceId = s.state === 'idle' && s.kind === 'port' ? s.id : undefined;
  vscode.postMessage({
    type: 'connect',
    port: s.title,
    baudRate: cfg?.baudRate ?? (Number(baudInput.value) || 115200),
    dataBits: cfg?.dataBits ?? Number(dataBitsSelect.value),
    stopBits: cfg?.stopBits ?? Number(stopBitsSelect.value),
    parity: cfg?.parity ?? paritySelect.value,
  });
}

function sendCurrent(s: TabSession): void {
  if (s.kind !== 'port' || s.state !== 'connected') {
    return;
  }
  const text = s.dom.sendInput.value;
  s.dom.sendInput.value = '';
  if (text && s.sendHistory[s.sendHistory.length - 1] !== text) {
    s.sendHistory.push(text);
    if (s.sendHistory.length > 100) {
      s.sendHistory.shift();
    }
  }
  s.sendIndex = s.sendHistory.length;
  s.sendDraft = '';
  vscode.postMessage({ type: 'send', sessionId: s.id, text, lineEnding: lineEndingSelect.value });
}

function clearBuffer(s: TabSession): void {
  s.lineStore.length = 0;
  s.decisions.length = 0;
  s.visibleIndexes = [];
  s.scroll = scrollReducer(s.scroll, { type: 'reset' });
  s.marksDirty = true;
  scheduleRender(s);
  if (s.find.open) {
    recomputeOccurrences(s);
  }
  refreshPaneControls(s);
}

function renderChips(): void {
  tagsRow.textContent = '';
  tagsRow.style.display = tags.length ? 'flex' : 'none';
  for (const t of tags) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (t.highlight || t.filter ? '' : ' chip-off');
    chip.style.borderColor = t.color;
    chip.style.background = t.highlight ? `${t.color}33` : 'transparent';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = t.name;
    const segH = document.createElement('span');
    segH.className = 'seg' + (t.highlight ? ' on' : '');
    segH.textContent = 'H';
    segH.title = t.highlight ? 'Highlighting ON — click to turn off' : 'Highlighting OFF — click to turn on';
    segH.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { highlight: !t.highlight } });
    });
    const segF = document.createElement('span');
    segF.className = 'seg' + (t.filter ? ' on' : '');
    segF.textContent = 'F';
    segF.title = t.filter ? 'Filtering ON — click to turn off' : 'Filtering OFF — click to turn on';
    segF.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { filter: !t.filter } });
    });
    chip.title = `"${t.name}" — H: highlight on/off, F: filter on/off, double-click: delete`;
    chip.addEventListener('dblclick', () => vscode.postMessage({ type: 'removeTag', id: t.id }));
    chip.append(nameSpan, segH, segF);
    tagsRow.appendChild(chip);
  }
  renderManagePanel();
}

let manageOpen = false;

function renderManagePanel(): void {
  managePanel.style.display = manageOpen ? 'flex' : 'none';
  if (!manageOpen) {
    managePanel.textContent = '';
    return;
  }
  managePanel.textContent = '';
  const addRow = document.createElement('div');
  addRow.className = 'tag-edit-row';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'tag-pattern';
  addInput.placeholder = 'New tag pattern — type and press Enter (or click + Add)';
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add';
  addBtn.textContent = '+ Add';
  const addTag = () => {
    const value = addInput.value.trim();
    if (!value) {
      return;
    }
    vscode.postMessage({ type: 'createTag', pattern: value });
  };
  addBtn.addEventListener('click', addTag);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addTag();
    }
  });
  const clearAllBtn = document.createElement('button');
  clearAllBtn.className = 'tag-delete';
  clearAllBtn.textContent = 'Delete all';
  clearAllBtn.title = 'Remove every tag';
  clearAllBtn.disabled = tags.length === 0;
  clearAllBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearTags' });
  });
  addRow.append(addInput, addBtn, clearAllBtn);
  managePanel.appendChild(addRow);
  for (const t of tags) {
    const row = document.createElement('div');
    row.className = 'tag-edit-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'tag-name';
    nameInput.value = t.name;
    nameInput.title = 'Tag name';
    nameInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { name: nameInput.value } });
    });

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'tag-pattern';
    patternInput.value = t.pattern;
    patternInput.placeholder = 'Match pattern (substring or regex source)';
    patternInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { pattern: patternInput.value } });
    });

    const hlLabel = document.createElement('label');
    const hlInput = document.createElement('input');
    hlInput.type = 'checkbox';
    hlInput.checked = t.highlight;
    hlInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { highlight: hlInput.checked } });
    });
    hlLabel.appendChild(hlInput);
    hlLabel.appendChild(document.createTextNode('H'));

    const flLabel = document.createElement('label');
    const flInput = document.createElement('input');
    flInput.type = 'checkbox';
    flInput.checked = t.filter;
    flInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { filter: flInput.checked } });
    });
    flLabel.appendChild(flInput);
    flLabel.appendChild(document.createTextNode('F'));

    const regexLabel = document.createElement('label');
    const regexInput = document.createElement('input');
    regexInput.type = 'checkbox';
    regexInput.checked = t.isRegex;
    regexInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { isRegex: regexInput.checked } });
    });
    regexLabel.appendChild(regexInput);
    regexLabel.appendChild(document.createTextNode('regex'));

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = t.color;
    colorInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', id: t.id, patch: { color: colorInput.value } });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tag-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = `Delete tag "${t.name}"`;
    deleteBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeTag', id: t.id });
    });

    row.append(nameInput, patternInput, regexLabel, hlLabel, flLabel, colorInput, deleteBtn);
    managePanel.appendChild(row);
  }
  if (!tags.length) {
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'No tags yet — type a pattern above, or select text in the output and press the tag button.';
    managePanel.appendChild(hint);
  }
}

manageToggleBtn.addEventListener('click', () => {
  manageOpen = !manageOpen;
  renderManagePanel();
});

// --- Host messages -----------------------------------------------------------

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'ports') {
    fillPorts(m.ports);
    updateButtons();
  } else if (m.type === 'state') {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (!s) {
      return;
    }
    s.state = m.state;
    s.message = m.message;
    if (m.state === 'connected' && pendingReplaceId !== undefined && m.sessionId !== pendingReplaceId) {
      const replaced = sessions.find((x) => x.id === pendingReplaceId);
      // The new session went live on the same port: close the idle pane it replaces.
      if (replaced && replaced.title === s.title) {
        pendingReplaceId = undefined;
        vscode.postMessage({ type: 'closeSession', sessionId: replaced.id });
        removeSession(replaced.id);
      }
    }
    refreshPaneControls(s);
    if (s.id === focusedId) {
      setStatus();
    }
  } else if (m.type === 'append') {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (s) {
      appendToSession(s, m.lines.map((text: string, i: number) => ({ text, ts: m.timestamps?.[i] })), m.dropCount);
    }
  } else if (m.type === 'timestamps') {
    showTimestamps = m.enabled;
    renderTimestampsControl(); // keep the toggle in sync with the setting
    for (const s of sessions) {
      s.marksDirty = true; // rows re-render with/without the [hh:mm:ss] prefix
      scheduleRender(s);
      if (s.find.open) {
        recomputeOccurrences(s); // the rendered text changed under the query
      }
    }
  } else if (m.type === 'logging') {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (!s) {
      return;
    }
    s.logDesired = Boolean(m.desired);
    s.logFile = m.fileName;
    s.logDirectory = m.directory;
    logDirBtn.classList.toggle('logging', Boolean(m.directory));
    logDirBtn.title = m.directory
      ? `Logging each session into ${m.directory} — right-click to clear`
      : 'Choose a log directory: every logged session writes a new .log file (right-click to clear)';
    refreshPaneControls(s);
  } else if (m.type === 'recentBauds') {
    recentBauds = m.values;
  } else if (m.type === 'exportRequest') {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (s) {
      vscode.postMessage({ type: 'exportData', sessionId: s.id, entries: s.lineStore });
    }
  } else if (m.type === 'status') {
    setStatus(m.message);
  } else if (m.type === 'clear') {
    // API-triggered clear targets the focused pane; pane buttons send their
    // own message with a sessionId.
    const f = focusedSession();
    if (f) {
      if (f.kind === 'port') {
        vscode.postMessage({ type: 'clear', sessionId: f.id }); // host resets its ring count too
      }
      clearBuffer(f);
    }
  } else if (m.type === 'lineEnding') {
    lineEndingSelect.value = m.value;
  } else if (m.type === 'tags') {
    tags = m.tags;
    renderChips();
    restyleAllRows();
  } else if (m.type === 'sessionCreated') {
    createSession(m);
  } else if (m.type === 'sessionFailed') {
    const wasFocused = focusedId === m.sessionId;
    removeSession(m.sessionId);
    if (wasFocused || focusedId === undefined) {
      setStatus(m.message);
    }
  } else if (m.type === 'sessionClosed') {
    removeSession(m.sessionId);
  }
});

// --- Starting monitors ---------------------------------------------------------

function startMonitoring(): void {
  const path = portSelect.value;
  if (!path) {
    return;
  }
  // Already monitored: focus that pane instead of failing to open the port
  // a second time.
  const live = sessions.find((x) => x.kind === 'port' && x.state === 'connected' && x.title === path);
  if (live) {
    setFocused(live.id);
    setStatus(`${path} is already being monitored`);
    return;
  }
  // Starting over a stopped pane on the same port reconnects in place: the
  // old pane closes once the new session connects.
  const stopped = sessions.find(
    (s) => s.kind === 'port' && s.state === 'idle' && s.title === path,
  );
  pendingReplaceId = stopped?.id;
  vscode.postMessage({
    type: 'connect',
    port: path,
    baudRate: Number(baudInput.value) || 115200,
    dataBits: Number(dataBitsSelect.value),
    stopBits: Number(stopBitsSelect.value),
    parity: paritySelect.value,
  });
}

connectBtn.addEventListener('click', startMonitoring);

// ＋ opens another monitor: a new pane splits the view while the existing
// ones keep streaming.
addMonitorBtn.addEventListener('click', startMonitoring);

timestampsBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'setTimestamps', enabled: !showTimestamps });
});

openLogFileBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openLogFile' });
});

// Ctrl+F finds in the focused pane, like the editor's find widget.
// F3 / Shift+F3 walk the matches once find is open.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    const f = focusedSession();
    if (f) {
      e.preventDefault();
      openFind(f);
    }
    return;
  }
  if (e.key === 'F3') {
    const f = focusedSession();
    if (f && f.find.open) {
      e.preventDefault();
      navigateFind(f, e.shiftKey ? -1 : 1);
    }
  }
});

// --- Filter menu -------------------------------------------------------------

// Filtering is display-layer only (ADR-0004): switching modes recomputes
// visibility for every pane and never changes Follow/locked state.
function setFilterMode(mode: FilterMode): void {
  filterMode = mode;
  filterToggleBtn.classList.toggle('on', mode !== 'off');
  filterToggleBtn.title = `Filter: ${mode === 'off' ? 'off' : mode} — click to choose`;
  restyleAllRows();
}

function renderFilterMenu(): void {
  filterMenu.textContent = '';
  const options: { mode: FilterMode; label: string; hint: string }[] = [
    { mode: 'off', label: 'Off', hint: 'Show every line' },
    { mode: 'include', label: 'Include', hint: 'Show only lines matching a filter tag' },
    { mode: 'exclude', label: 'Exclude', hint: 'Hide lines matching a filter tag' },
  ];
  for (const o of options) {
    const item = document.createElement('div');
    item.className = 'menu-item' + (o.mode === filterMode ? ' current' : '');
    item.textContent = (o.mode === filterMode ? '\u2714\uFE0E ' : '') + o.label;
    item.title = o.hint;
    item.addEventListener('click', () => {
      filterMenu.style.display = 'none';
      setFilterMode(o.mode);
    });
    filterMenu.appendChild(item);
  }
}

filterToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (filterMenu.style.display === 'block') {
    filterMenu.style.display = 'none';
    return;
  }
  renderFilterMenu();
  filterMenu.style.display = 'block';
});

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshPorts' });
});

// --- Baud quick-pick ---------------------------------------------------------

function renderBaudMenu(): void {
  baudMenu.textContent = '';
  const current = baudInput.value.trim();
  const pushItem = (b: number, recent: boolean) => {
    const item = document.createElement('div');
    item.className = 'menu-item' + (recent ? ' recent' : '');
    item.textContent = (String(b) === current ? '\u2714\uFE0E ' : '') + String(b);
    item.title = recent ? 'Recently used' : '';
    item.addEventListener('click', () => {
      baudInput.value = String(b);
      baudMenu.style.display = 'none';
    });
    baudMenu.appendChild(item);
  };
  const header = (label: string) => {
    const h = document.createElement('div');
    h.className = 'menu-header';
    h.textContent = label;
    baudMenu.appendChild(h);
  };
  const used = new Set<number>();
  if (recentBauds.length) {
    header('Recent');
    for (const b of recentBauds) {
      used.add(b);
      pushItem(b, true);
    }
    header('Presets');
  }
  for (const b of BAUD_RATE_PRESETS) {
    if (!used.has(b)) {
      pushItem(b, false);
    }
  }
}

baudToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (baudMenu.style.display === 'block') {
    baudMenu.style.display = 'none';
    return;
  }
  renderBaudMenu();
  baudMenu.style.display = 'block';
});

document.addEventListener('click', (e) => {
  const target = e.target as Node;
  if (baudMenu.style.display === 'block' && target !== baudToggleBtn && !baudMenu.contains(target)) {
    baudMenu.style.display = 'none';
  }
  if (filterMenu.style.display === 'block' && target !== filterToggleBtn && !filterMenu.contains(target)) {
    filterMenu.style.display = 'none';
  }
});

logDirBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'chooseLogDirectory' });
});
logDirBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  vscode.postMessage({ type: 'clearLogDirectory' });
});

// Quick collapse: hide the hardware row — content controls stay at hand
// while the consoles take the full panel height.
let hwVisible = true;
collapseHwBtn.addEventListener('click', () => {
  hwVisible = !hwVisible;
  hwRow.style.display = hwVisible ? 'flex' : 'none';
  collapseHwBtn.innerHTML = hwVisible ? '&#9652;' : '&#9662;';
  collapseHwBtn.title = hwVisible ? 'Hide the hardware row' : 'Show the hardware row';
});

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', () => {
  for (const s of sessions) {
    s.marksDirty = true;
    scheduleRender(s);
  }
});

syncEmptyState();
renderTimestampsControl();
setFilterMode('off');
updateButtons();
vscode.postMessage({ type: 'ready' });
