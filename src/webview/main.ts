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
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const tagBtn = document.getElementById('create-tag') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const tagsRow = document.getElementById('tags-row') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const marksStrip = document.getElementById('log-marks') as HTMLDivElement;
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
const tabsRow = document.getElementById('tabs-row') as HTMLDivElement;
const collapseHwBtn = document.getElementById('collapse-hw') as HTMLButtonElement;
const hwRow = document.getElementById('hw-row') as HTMLDivElement;
const manageToggleBtn = document.getElementById('manage-toggle') as HTMLButtonElement;
const managePanel = document.getElementById('manage-panel') as HTMLDivElement;

/**
 * One tab's worth of state. Ports and opened log files are both sessions:
 * a port session streams from its controller, a file session is a read-only
 * snapshot. Buffers, scroll position, connection state, and log-to-file are
 * per session; tags, filter mode, and timestamps are global display choices.
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
}

const sessions: TabSession[] = [];
let activeId: number | undefined;
// When Start replaces an idle tab on the same port, the old tab closes only
// after the new session actually connects (a failed open keeps the buffer).
let pendingReplaceId: number | undefined;

// Display-layer globals shared by every tab.
let filterMode: FilterMode = 'off';
let showTimestamps = false;
let tags: Tag[] = [];
let recentBauds: number[] = [];

function activeSession(): TabSession | undefined {
  return sessions.find((s) => s.id === activeId);
}

// Virtualized rendering: fixed-height rows, spacer divs hold the scrolled
// distance so only the visible window (plus overscan) exists in the DOM.
const OVERSCAN_ROWS = 20;
let rowHeightPx = 20;
let renderScheduled = false;
let marksDirty = true;

const spacerTop = document.createElement('div');
const spacerBottom = document.createElement('div');
spacerTop.className = 'log-spacer';
spacerBottom.className = 'log-spacer';

function measureRowHeight(): void {
  const probe = document.createElement('div');
  probe.className = 'row-line';
  probe.style.visibility = 'hidden';
  probe.textContent = 'X';
  log.appendChild(probe);
  rowHeightPx = probe.offsetHeight || 20;
  probe.remove();
}

function renderText(entry: { text: string; ts?: number }): string {
  if (showTimestamps && entry.ts !== undefined) {
    return `[${formatTimestamp(entry.ts)}] ${entry.text}`;
  }
  return entry.text;
}

function renderWindow(): void {
  renderScheduled = false;
  const s = activeSession();
  if (!s) {
    log.replaceChildren();
    const hint = document.createElement('div');
    hint.className = 'log-empty';
    hint.textContent =
      'No monitors open — pick a port above and press Start Monitoring, or open a saved log file.';
    log.appendChild(hint);
    lastRender = undefined;
    renderMarks();
    return;
  }
  const total = s.visibleIndexes.length;
  const first = Math.max(0, Math.floor(log.scrollTop / rowHeightPx) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((log.scrollTop + log.clientHeight) / rowHeightPx) + OVERSCAN_ROWS);

  interface RowSpec {
    lineIndex: number;
    text: string;
    bg: string;
    bgImage: string;
    textIndent: string;
  }
  const rows: RowSpec[] = [];
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
  const prev = lastRender;
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
    renderMarks();
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
  log.replaceChildren(spacerTop, frag, spacerBottom);
  restoreSelection(savedSelection);
  lastRender = { topPx, bottomPx, rows };
  renderMarks();
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
let lastRender: { topPx: number; bottomPx: number; rows: RenderedRow[] } | undefined;

/** Overview strip beside the scrollbar: one block per tag-highlighted line,
 * squashed to the viewport like the editor's overview ruler. Positions live
 * in filtered (visible) row space so they track what the scrollbar shows. */
function renderMarks(): void {
  if (!marksDirty) {
    return;
  }
  marksDirty = false;
  const s = activeSession();
  const total = s?.visibleIndexes.length ?? 0;
  const height = Math.max(1, log.clientHeight - 8); // the strip insets 4px top/bottom
  const buckets = new Map<number, string>();
  if (s && total > 0) {
    for (let p = 0; p < total; p++) {
      const colors = s.decisions[s.visibleIndexes[p]].highlightColors;
      if (colors.length) {
        const row = Math.min(height - 1, Math.floor((p / total) * height));
        if (!buckets.has(row)) {
          buckets.set(row, colors[0]);
        }
      }
    }
  }
  marksStrip.textContent = '';
  if (!buckets.size) {
    marksStrip.style.display = 'none';
    return;
  }
  for (const [row, color] of buckets) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.top = `${row}px`;
    mark.style.background = color;
    marksStrip.appendChild(mark);
  }
  marksStrip.style.display = 'block';
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
  const findRow = (line: number) => log.querySelector(`.row-line[data-line-index="${line}"]`);
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

function scheduleRender(): void {
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(renderWindow);
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
  if (s.id === activeId) {
    marksDirty = true;
  }
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
  if (s.id === activeId) {
    marksDirty = true;
    scheduleRender();
    if (s.scroll === 'follow') {
      // Pin to the bottom after the window re-renders with the new content.
      requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    }
    updateButtons();
  }
}

/** Tags, filter mode, and timestamps are global: a change re-decides every
 * tab's lines, not just the active one. */
function restyleAllRows(): void {
  for (const s of sessions) {
    for (let i = 0; i < s.lineStore.length; i++) {
      s.decisions[i] = matchLine(s.lineStore[i].text, tags, filterMode);
    }
    rebuildVisibleIndexes(s);
  }
  marksDirty = true;
  scheduleRender();
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
  portSelect.disabled = activeSession()?.state === 'connected';
  for (const p of ports) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.description ? `${p.path} - ${p.description}` : p.path;
    portSelect.appendChild(o);
  }
  // Tab switches restore their port into the selector when it still exists.
  const s = activeSession();
  if (s && s.kind === 'port' && Array.from(portSelect.options).some((o) => o.value === s.title)) {
    portSelect.value = s.title;
  }
}

function updateButtons(): void {
  const s = activeSession();
  const isConnected = s?.kind === 'port' && s.state === 'connected';
  const isConnecting = s?.kind === 'port' && s.state === 'connecting';
  connectBtn.innerHTML = isConnected ? '&#9632; Stop Monitoring' : '&#9654; Start Monitoring';
  connectBtn.disabled = isConnecting || (!isConnected && portSelect.value === '');
  portSelect.disabled = isConnected;
  refreshBtn.disabled = isConnected;
  clearBtn.disabled = !(isConnected || (s !== undefined && s.lineStore.length > 0));
  sendBtn.disabled = !isConnected;
  sendInput.disabled = !isConnected;
  sendInput.placeholder =
    s?.kind === 'file'
      ? `Read-only log file: ${s.title}`
      : 'Type in a message to send to the serial port...';
  exportBtn.disabled = s === undefined || s.lineStore.length === 0;
  logSessionBtn.disabled = !s || s.kind !== 'port' || s.state === 'connecting';
  renderLogSessionControl();
  updateTagButton();
}

function renderTimestampsControl(): void {
  timestampsBtn.classList.toggle('on', showTimestamps);
  timestampsBtn.title = `Timestamps: ${showTimestamps ? 'on' : 'off'} — click to ${showTimestamps ? 'hide' : 'show'} them`;
}

function renderLogSessionControl(): void {
  const s = activeSession();
  const on = Boolean(s && s.kind === 'port' && s.logDesired);
  logSessionBtn.classList.toggle('on', on);
  logSessionBtn.innerHTML = on ? '&#128308;&#65039;' : '&#9898;&#65039;';
  if (!s || s.kind !== 'port') {
    logSessionBtn.title = 'Log to file — start monitoring a port first';
  } else if (on) {
    const where = s.logFile ? ` (now: ${s.logFile})` : s.logDirectory ? ` into ${s.logDirectory}` : '';
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
  const s = activeSession();
  statusEl.textContent =
    message ||
    s?.message ||
    (s
      ? s.state === 'connected'
        ? 'Connected'
        : s.state === 'connecting'
          ? 'Connecting...'
          : 'Idle'
      : 'Idle');
}

// --- Tab strip ---------------------------------------------------------------

function renderTabs(): void {
  tabsRow.textContent = '';
  tabsRow.style.display = sessions.length ? 'flex' : 'none';
  for (const s of sessions) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (s.id === activeId ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'tab-dot' + (s.state === 'connected' ? ' live' : s.state === 'connecting' ? ' pending' : '');
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = (s.kind === 'file' ? '\u{1F4C4} ' : '') + s.title;
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.title = 'Close this tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSessionLocal(s.id);
    });
    tab.title =
      s.kind === 'file'
        ? `Log file ${s.title} (read-only)`
        : `${s.title} — ${s.state === 'connected' ? 'monitoring' : s.state === 'connecting' ? 'connecting' : 'stopped'}`;
    tab.append(dot, title, close);
    tab.addEventListener('click', () => activateSession(s.id));
    tabsRow.appendChild(tab);
  }
  // "+" opens the blank "new monitor" state: the hardware row unlocks there,
  // so another port can be started while existing tabs keep streaming.
  const newTab = document.createElement('div');
  newTab.className = 'tab tab-new';
  newTab.textContent = '+';
  newTab.title = 'Open another monitor (new tab)';
  newTab.addEventListener('click', activateNewTab);
  tabsRow.appendChild(newTab);
}

/** The blank between-tabs state: no active session, hardware row unlocked. */
function activateNewTab(): void {
  activeId = undefined;
  lastRender = undefined;
  marksDirty = true;
  renderTabs();
  updateButtons();
  setStatus();
  renderScrollIndicator();
  scheduleRender();
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
  };
  sessions.push(s);
  renderTabs();
  activateSession(s.id);
  return s;
}

function activateSession(id: number): void {
  activeId = id;
  const s = activeSession();
  if (s && s.kind === 'port' && Array.from(portSelect.options).some((o) => o.value === s.title)) {
    portSelect.value = s.title;
  }
  lastRender = undefined;
  marksDirty = true;
  renderTabs();
  updateButtons();
  setStatus();
  renderScrollIndicator();
  scheduleRender();
  // Restore the tab's scroll position once the spacers carry its height;
  // a following tab snaps back to the live bottom instead.
  requestAnimationFrame(() => {
    if (s) {
      log.scrollTop = s.scroll === 'follow' ? log.scrollHeight : s.scrollTop;
    }
  });
}

function removeSession(id: number): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return;
  }
  sessions.splice(idx, 1);
  if (pendingReplaceId === id) {
    pendingReplaceId = undefined;
  }
  if (activeId === id) {
    const next = sessions[idx] ?? sessions[idx - 1];
    if (next) {
      activateSession(next.id);
    } else {
      activeId = undefined;
      lastRender = undefined;
      marksDirty = true;
      renderTabs();
      updateButtons();
      setStatus();
      renderScrollIndicator();
      scheduleRender();
    }
  } else {
    renderTabs();
  }
}

/** Closes a tab locally and tells the host to tear the session down. */
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
      // The new session went live on the same port: drop the idle tab it replaces.
      if (replaced && replaced.title === s.title) {
        pendingReplaceId = undefined;
        closeSessionLocal(replaced.id);
      }
    }
    renderTabs();
    if (s.id === activeId) {
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
    marksDirty = true; // rows re-render with/without the [hh:mm:ss] prefix
    scheduleRender();
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
    if (s.id === activeId) {
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
    // API-triggered clear targets the active tab; the button path sends its
    // own message with a sessionId.
    const s = activeSession();
    if (s) {
      if (s.kind === 'port') {
        vscode.postMessage({ type: 'clear', sessionId: s.id }); // host resets its ring count too
      }
      clearBuffer(s);
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
    const wasActive = activeId === m.sessionId;
    removeSession(m.sessionId);
    if (wasActive || activeId === undefined) {
      setStatus(m.message);
    }
  } else if (m.type === 'sessionClosed') {
    removeSession(m.sessionId);
  }
});

// --- Connect / disconnect ----------------------------------------------------

connectBtn.addEventListener('click', () => {
  const s = activeSession();
  if (s?.kind === 'port' && s.state === 'connecting') {
    return;
  }
  if (s?.kind === 'port' && s.state === 'connected') {
    vscode.postMessage({ type: 'disconnect', sessionId: s.id });
    return;
  }
  const path = portSelect.value;
  if (!path) {
    return;
  }
  // Starting from a stopped tab on the same port reconnects in place: the
  // old tab closes once the new session connects.
  pendingReplaceId =
    s && s.kind === 'port' && s.state === 'idle' && s.title === path ? s.id : undefined;
  vscode.postMessage({
    type: 'connect',
    port: path,
    baudRate: Number(baudInput.value) || 115200,
    dataBits: Number(dataBitsSelect.value),
    stopBits: Number(stopBitsSelect.value),
    parity: paritySelect.value,
  });
});

function sendCurrent(): void {
  const s = activeSession();
  if (!s || s.kind !== 'port' || s.state !== 'connected') {
    return;
  }
  const text = sendInput.value;
  sendInput.value = '';
  vscode.postMessage({ type: 'send', sessionId: s.id, text, lineEnding: lineEndingSelect.value });
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
  const s = activeSession();
  if (!s || s.kind !== 'port' || s.state === 'connecting') {
    return;
  }
  vscode.postMessage({ type: 'setLogSession', sessionId: s.id, enabled: !s.logDesired });
});

openLogFileBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openLogFile' });
});

function clearBuffer(s: TabSession): void {
  s.lineStore.length = 0;
  s.decisions.length = 0;
  s.visibleIndexes = [];
  s.scroll = scrollReducer(s.scroll, { type: 'reset' });
  if (s.id === activeId) {
    marksDirty = true;
    scheduleRender();
    renderScrollIndicator();
  }
  updateButtons();
}

function clearMonitor(): void {
  const s = activeSession();
  if (!s) {
    return;
  }
  if (s.kind === 'port') {
    vscode.postMessage({ type: 'clear', sessionId: s.id }); // host resets its ring count too
  }
  clearBuffer(s);
}

clearBtn.addEventListener('click', clearMonitor);

// --- Scrolling ---------------------------------------------------------------

// Scroll Lock: user scrolls drive the follow/locked reducer; programmatic
// pinning only ever scrolls to the bottom, which keeps Follow.
log.addEventListener('scroll', () => {
  const s = activeSession();
  if (s) {
    s.scrollTop = log.scrollTop;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const next = scrollReducer(s.scroll, { type: 'scrolled', atBottom });
    if (next !== s.scroll) {
      s.scroll = next;
      renderScrollIndicator();
    }
  }
  scheduleRender();
});

scrollStateBtn.addEventListener('click', () => {
  const s = activeSession();
  if (!s) {
    return;
  }
  s.scroll = scrollReducer(s.scroll, { type: 'toggle' });
  if (s.scroll === 'follow') {
    log.scrollTop = log.scrollHeight; // rejoining the stream snaps to the bottom
  }
  renderScrollIndicator();
});

// The strip squashes the whole buffer to the viewport; clicking at a height
// fraction jumps to the same fraction of the document.
marksStrip.addEventListener('click', (e) => {
  const rect = marksStrip.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  log.scrollTop = frac * (log.scrollHeight - log.clientHeight);
});

function renderScrollIndicator(): void {
  const mode = activeSession()?.scroll ?? 'follow';
  scrollStateBtn.innerHTML = mode === 'follow' ? '&#8681; Following' : '&#128274; Locked';
  scrollStateBtn.title =
    mode === 'follow'
      ? 'Viewport follows new lines — click to lock'
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
// visibility for every tab and never changes Follow/locked state.
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
// stay at hand while the console takes the full panel height.
let hwVisible = true;
collapseHwBtn.addEventListener('click', () => {
  hwVisible = !hwVisible;
  hwRow.style.display = hwVisible ? 'flex' : 'none';
  collapseHwBtn.innerHTML = hwVisible ? '&#9652;' : '&#9662;';
  collapseHwBtn.title = hwVisible ? 'Hide the hardware row' : 'Show the hardware row';
});

exportBtn.addEventListener('click', () => {
  const s = activeSession();
  if (!s) {
    return;
  }
  vscode.postMessage({ type: 'export', sessionId: s.id });
});

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', () => {
  marksDirty = true;
  scheduleRender();
});

measureRowHeight();
renderScrollIndicator();
renderTimestampsControl();
renderLogSessionControl();
setFilterMode('off');
scheduleRender();
vscode.postMessage({ type: 'ready' });
