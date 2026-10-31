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
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const tagBtn = document.getElementById('create-tag') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const tagsRow = document.getElementById('tags-row') as HTMLDivElement;
const panesArea = document.getElementById('panes') as HTMLDivElement;
const sendInput = document.getElementById('send-input') as HTMLInputElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const scrollStateBtn = document.getElementById('scroll-state') as HTMLButtonElement;
const exportBtn = document.getElementById('export-log') as HTMLButtonElement;
const logDirBtn = document.getElementById('log-dir') as HTMLButtonElement;
const openLogFileBtn = document.getElementById('open-log-file') as HTMLButtonElement;
const baudToggleBtn = document.getElementById('baud-toggle') as HTMLButtonElement;
const baudMenu = document.getElementById('baud-menu') as HTMLDivElement;
const timestampsBtn = document.getElementById('timestamps') as HTMLButtonElement;
const logSessionBtn = document.getElementById('log-session') as HTMLButtonElement;
const filterToggleBtn = document.getElementById('filter-toggle') as HTMLButtonElement;
const filterMenu = document.getElementById('filter-menu') as HTMLDivElement;
const collapseHwBtn = document.getElementById('collapse-hw') as HTMLButtonElement;
const hwRow = document.getElementById('hw-row') as HTMLDivElement;
const manageToggleBtn = document.getElementById('manage-toggle') as HTMLButtonElement;
const managePanel = document.getElementById('manage-panel') as HTMLDivElement;

/** Per-pane DOM owned by a session. The pane lives in #panes; the log and
 * the highlight-marks strip are per pane so every session renders on its own. */
interface PaneDom {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  title: HTMLSpanElement;
  close: HTMLSpanElement;
  log: HTMLDivElement;
  marks: HTMLDivElement;
}

/**
 * One split-view pane's worth of state. Ports and opened log files are both
 * sessions: a port session streams from its controller, a file session is a
 * read-only snapshot. Buffers, scroll position, connection state, and
 * log-to-file are per session; tags, filter mode, and timestamps are global
 * display choices. The focused pane receives the toolbar's actions.
 */
interface TabSession {
  id: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  message?: string;
  lineStore: { text: string; ts?: number }[];
  decisions: LineDecision[];
  visibleIndexes: number[];
  scroll: ScrollState;
  scrollTop: number;
  logDesired: boolean;
  logFile?: string;
  logDirectory?: string;
  dom: PaneDom;
  lastRender?: { topPx: number; bottomPx: number; rows: RenderedRow[] };
  marksDirty: boolean;
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

const spacerTop = document.createElement('div');
const spacerBottom = document.createElement('div');
spacerTop.className = 'log-spacer';
spacerBottom.className = 'log-spacer';

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
  spacerTop.style.height = `${topPx}px`;
  spacerBottom.style.height = `${bottomPx}px`;
  logEl.replaceChildren(spacerTop, frag, spacerBottom);
  restoreSelection(savedSelection);
  s.lastRender = { topPx, bottomPx, rows };
  renderMarksFor(s);
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
  if (s.scroll === 'follow') {
    // Pin to the bottom after the window re-renders with the new content.
    requestAnimationFrame(() => {
      s.dom.log.scrollTop = s.dom.log.scrollHeight;
    });
  }
  if (s.id === focusedId) {
    updateButtons();
  }
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
  const f = focusedSession();
  const isConnected = f?.kind === 'port' && f.state === 'connected';
  const isConnecting = f?.kind === 'port' && f.state === 'connecting';
  connectBtn.innerHTML = isConnected ? '&#9632; Stop Monitoring' : '&#9654; Start Monitoring';
  connectBtn.title = isConnected
    ? `Stop monitoring ${f?.title}`
    : isConnecting
      ? 'Connecting...'
      : 'Start monitoring the selected port in a new pane';
  connectBtn.disabled = Boolean(isConnecting) || (!isConnected && portSelect.value === '');
  portSelect.disabled = false;
  refreshBtn.disabled = false;
  clearBtn.disabled = !f || (f.lineStore.length === 0 && !isConnected);
  sendBtn.disabled = !isConnected;
  sendInput.disabled = !isConnected;
  sendInput.placeholder = isConnected
    ? `To ${f?.title}: type in a message to send to the serial port...`
    : f?.kind === 'file'
      ? `Read-only log file: ${f.title}`
      : 'Type in a message to send to the serial port...';
  exportBtn.disabled = f === undefined || f.lineStore.length === 0;
  logSessionBtn.disabled = !f || f.kind !== 'port' || f.state === 'connecting';
  renderLogSessionControl();
  updateTagButton();
}

function renderTimestampsControl(): void {
  timestampsBtn.classList.toggle('on', showTimestamps);
  timestampsBtn.title = `Timestamps: ${showTimestamps ? 'on' : 'off'} — click to ${showTimestamps ? 'hide' : 'show'} them`;
}

function renderLogSessionControl(): void {
  const f = focusedSession();
  const on = Boolean(f && f.kind === 'port' && f.logDesired);
  logSessionBtn.classList.toggle('on', on);
  logSessionBtn.innerHTML = on ? '&#128308;&#65039;' : '&#9898;&#65039;';
  if (!f || f.kind !== 'port') {
    logSessionBtn.title = 'Log to file — focus a port pane first';
  } else if (on) {
    const where = f.logFile ? ` (now: ${f.logFile})` : f.logDirectory ? ` into ${f.logDirectory}` : '';
    logSessionBtn.title = `Log to file: on${where} — click to stop`;
  } else {
    logSessionBtn.title = 'Log to file: off — click to log this session to a .log file';
  }
}

function updateTagButton(): void {
  const selected = window.getSelection()?.toString().trim() ?? '';
  tagBtn.disabled = selected.length === 0;
  tagBtn.title = selected
    ? `Create a tag from "${selected.length > 24 ? selected.slice(0, 24) + '…' : selected}"`
    : 'Create a tag from the selected text (or type one in the ⚙ panel)';
}

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

function buildPane(s: TabSession): PaneDom {
  const root = document.createElement('div');
  root.className = 'pane';
  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const title = document.createElement('span');
  title.className = 'pane-title';
  title.textContent = (s.kind === 'file' ? '\u{1F4C4} ' : '') + s.title;
  const close = document.createElement('span');
  close.className = 'pane-close';
  close.textContent = '\u00d7';
  close.title = 'Close this pane';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSessionLocal(s.id);
  });
  header.append(dot, title, close);

  const body = document.createElement('div');
  body.className = 'pane-body';
  const logEl = document.createElement('div');
  logEl.className = 'pane-log';
  const marks = document.createElement('div');
  marks.className = 'log-marks';
  marks.title = 'Highlighted lines — click to jump';
  body.append(logEl, marks);

  root.append(header, body);
  root.addEventListener('click', () => setFocused(s.id));
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
      if (s.id === focusedId) {
        renderScrollIndicator();
      }
    }
    scheduleRender(s);
  });
  panesArea.appendChild(root);
  return { root, dot, title, close, log: logEl, marks };
}

function createSession(m: {
  sessionId: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
}): TabSession {
  const s: TabSession = {
    id: m.sessionId,
    kind: m.kind,
    title: m.title,
    state: m.state,
    lineStore: [],
    decisions: [],
    visibleIndexes: [],
    scroll: 'follow',
    scrollTop: 0,
    logDesired: false,
    marksDirty: true,
    dom: undefined as unknown as PaneDom,
  };
  sessions.push(s);
  syncEmptyState();
  s.dom = buildPane(s);
  measureRowHeight(s.dom.log);
  setFocused(s.id);
  return s;
}

function setFocused(id: number | undefined): void {
  focusedId = id;
  for (const s of sessions) {
    s.dom.root.classList.toggle('focused', s.id === focusedId);
  }
  updateButtons();
  setStatus();
  renderScrollIndicator();
}

function removeSession(id: number): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return;
  }
  const [gone] = sessions.splice(idx, 1);
  gone.dom.root.remove();
  pendingRenders.delete(gone);
  if (pendingReplaceId === id) {
    pendingReplaceId = undefined;
  }
  if (focusedId === id) {
    const next = sessions[idx] ?? sessions[idx - 1];
    setFocused(next?.id);
    if (!next) {
      syncEmptyState();
    }
  }
  if (sessions.length === 0) {
    syncEmptyState();
  }
}

/** Closes a pane and tells the host to tear the session down. */
function closeSessionLocal(id: number): void {
  vscode.postMessage({ type: 'closeSession', sessionId: id });
  removeSession(id);
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
        closeSessionLocal(replaced.id);
      }
    }
    s.dom.dot.className = 'tab-dot' + (s.state === 'connected' ? ' live' : s.state === 'connecting' ? ' pending' : '');
    s.dom.root.title =
      s.kind === 'file'
        ? `Log file ${s.title} (read-only)`
        : `${s.title} — ${s.state === 'connected' ? 'monitoring' : s.state === 'connecting' ? 'connecting' : 'stopped'}`;
    if (s.id === focusedId) {
      updateButtons();
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
    if (s.id === focusedId) {
      renderLogSessionControl();
    }
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
    // API-triggered clear targets the focused pane; the button path sends
    // its own message with a sessionId.
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

// --- Connect / disconnect ----------------------------------------------------

function startMonitoring(): void {
  const path = portSelect.value;
  if (!path) {
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

connectBtn.addEventListener('click', () => {
  const f = focusedSession();
  if (f?.kind === 'port' && f.state === 'connecting') {
    return;
  }
  if (f?.kind === 'port' && f.state === 'connected') {
    vscode.postMessage({ type: 'disconnect', sessionId: f.id });
    return;
  }
  startMonitoring();
});

// ＋ opens another monitor: a new pane splits the view while the existing
// ones keep streaming.
addMonitorBtn.addEventListener('click', startMonitoring);

function sendCurrent(): void {
  const f = focusedSession();
  if (!f || f.kind !== 'port' || f.state !== 'connected') {
    return;
  }
  const text = sendInput.value;
  sendInput.value = '';
  vscode.postMessage({ type: 'send', sessionId: f.id, text, lineEnding: lineEndingSelect.value });
}

sendBtn.addEventListener('click', sendCurrent);
sendInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendCurrent();
  }
});

timestampsBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'setTimestamps', enabled: !showTimestamps });
});

logSessionBtn.addEventListener('click', () => {
  const f = focusedSession();
  if (!f || f.kind !== 'port' || f.state === 'connecting') {
    return;
  }
  vscode.postMessage({ type: 'setLogSession', sessionId: f.id, enabled: !f.logDesired });
});

openLogFileBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openLogFile' });
});

function clearBuffer(s: TabSession): void {
  s.lineStore.length = 0;
  s.decisions.length = 0;
  s.visibleIndexes = [];
  s.scroll = scrollReducer(s.scroll, { type: 'reset' });
  s.marksDirty = true;
  scheduleRender(s);
  if (s.id === focusedId) {
    renderScrollIndicator();
  }
  updateButtons();
}

function clearMonitor(): void {
  const f = focusedSession();
  if (!f) {
    return;
  }
  if (f.kind === 'port') {
    vscode.postMessage({ type: 'clear', sessionId: f.id }); // host resets its ring count too
  }
  clearBuffer(f);
}

clearBtn.addEventListener('click', clearMonitor);

scrollStateBtn.addEventListener('click', () => {
  const f = focusedSession();
  if (!f) {
    return;
  }
  f.scroll = scrollReducer(f.scroll, { type: 'toggle' });
  if (f.scroll === 'follow') {
    f.dom.log.scrollTop = f.dom.log.scrollHeight; // rejoining the stream snaps to the bottom
  }
  renderScrollIndicator();
});

function renderScrollIndicator(): void {
  const mode = focusedSession()?.scroll ?? 'follow';
  scrollStateBtn.innerHTML = mode === 'follow' ? '&#8681; Following' : '&#128274; Locked';
  scrollStateBtn.title =
    mode === 'follow'
      ? 'Focused pane follows new lines — click to lock'
      : 'Scroll locked, data keeps arriving — click to rejoin';
  scrollStateBtn.classList.toggle('locked', mode === 'locked');
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
    item.className = 'baud-item' + (o.mode === filterMode ? ' current' : '');
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
    item.className = 'baud-item' + (recent ? ' recent' : '');
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
    h.className = 'baud-menu-header';
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

// Quick collapse: hide the hardware row once connected — content controls
// stay at hand while the consoles take the full panel height.
let hwVisible = true;
collapseHwBtn.addEventListener('click', () => {
  hwVisible = !hwVisible;
  hwRow.style.display = hwVisible ? 'flex' : 'none';
  collapseHwBtn.innerHTML = hwVisible ? '&#9652;' : '&#9662;';
  collapseHwBtn.title = hwVisible ? 'Hide the hardware row' : 'Show the hardware row';
});

exportBtn.addEventListener('click', () => {
  const f = focusedSession();
  if (!f) {
    return;
  }
  vscode.postMessage({ type: 'export', sessionId: f.id });
});

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', () => {
  for (const s of sessions) {
    s.marksDirty = true;
    scheduleRender(s);
  }
});

syncEmptyState();
renderScrollIndicator();
renderTimestampsControl();
renderLogSessionControl();
setFilterMode('off');
updateButtons();
vscode.postMessage({ type: 'ready' });
