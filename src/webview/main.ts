declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

import { LineDecision, matchLine } from '../shared/tagMatching';
import { FilterMode, Tag } from '../shared/tag';
import { scrollReducer, ScrollState } from '../shared/scrollState';

const vscode = acquireVsCodeApi();

const portSelect = document.getElementById('port') as HTMLSelectElement;
const baudInput = document.getElementById('baud') as HTMLInputElement;
const dataBitsSelect = document.getElementById('data-bits') as HTMLSelectElement;
const paritySelect = document.getElementById('parity') as HTMLSelectElement;
const stopBitsSelect = document.getElementById('stop-bits') as HTMLSelectElement;
const lineEndingSelect = document.getElementById('line-ending') as HTMLSelectElement;
const filterSelect = document.getElementById('filter') as HTMLSelectElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const tagBtn = document.getElementById('create-tag') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const tagsRow = document.getElementById('tags-row') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const sendInput = document.getElementById('send-input') as HTMLInputElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const scrollStateBtn = document.getElementById('scroll-state') as HTMLButtonElement;
const manageToggleBtn = document.getElementById('manage-toggle') as HTMLButtonElement;
const managePanel = document.getElementById('manage-panel') as HTMLDivElement;

let state: 'idle' | 'connecting' | 'connected' = 'idle';
// The three-state control arrives with the filter ticket; rendering already
// honors visibility so include/exclude only need to flip this mode.
let filterMode: FilterMode = 'off';
let scroll: ScrollState = 'follow';
let tags: Tag[] = [];

// Buffered content: one entry per received line, capped by the host which
// reports drops via dropCount. decisions[i] is the cached matching decision
// for lineStore[i] (matching always uses the RAW text — the timestamp is
// display decoration only, story 25); visibleIndexes lists which lines the
// filter lets through.
const lineStore: { text: string; ts?: number }[] = [];
const decisions: LineDecision[] = [];
let visibleIndexes: number[] = [];
let showTimestamps = false;

// Virtualized rendering: fixed-height rows, spacer divs hold the scrolled
// distance so only the visible window (plus overscan) exists in the DOM.
const OVERSCAN_ROWS = 20;
let rowHeightPx = 20;
let renderScheduled = false;

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

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function renderWindow(): void {
  renderScheduled = false;
  const total = visibleIndexes.length;
  const first = Math.max(0, Math.floor(log.scrollTop / rowHeightPx) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((log.scrollTop + log.clientHeight) / rowHeightPx) + OVERSCAN_ROWS);

  interface RowSpec {
    lineIndex: number;
    text: string;
    bg: string;
  }
  const rows: RowSpec[] = [];
  for (let p = first; p < last; p++) {
    const lineIndex = visibleIndexes[p];
    const color = decisions[lineIndex].highlightColor;
    rows.push({
      lineIndex,
      text: renderText(lineStore[lineIndex]),
      bg: color ? `${color}45` : '',
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
    prev.rows.every((r, i) => r.lineIndex === rows[i].lineIndex && r.text === rows[i].text && r.bg === rows[i].bg)
  ) {
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
    frag.appendChild(row);
  }
  spacerTop.style.height = `${topPx}px`;
  spacerBottom.style.height = `${bottomPx}px`;
  log.replaceChildren(spacerTop, frag, spacerBottom);
  restoreSelection(savedSelection);
  lastRender = { topPx, bottomPx, rows };
}

interface RenderedRow {
  lineIndex: number;
  text: string;
  bg: string;
}
let lastRender: { topPx: number; bottomPx: number; rows: RenderedRow[] } | undefined;

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

function rebuildVisibleIndexes(): void {
  visibleIndexes = [];
  for (let i = 0; i < decisions.length; i++) {
    if (decisions[i].visible) {
      visibleIndexes.push(i);
    }
  }
}

function dropOldest(count: number): void {
  if (count <= 0) {
    return;
  }
  lineStore.splice(0, count);
  decisions.splice(0, count);
  rebuildVisibleIndexes();
}

function clearBuffer(): void {
  lineStore.length = 0;
  decisions.length = 0;
  visibleIndexes = [];
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
  portSelect.disabled = state === 'connected';
  for (const p of ports) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.description ? `${p.path} - ${p.description}` : p.path;
    portSelect.appendChild(o);
  }
}

function updateButtons(): void {
  const isConnected = state === 'connected';
  const isConnecting = state === 'connecting';
  connectBtn.innerHTML = isConnected ? '&#9632; Stop Monitoring' : '&#9654; Start Monitoring';
  connectBtn.disabled = isConnecting || (!isConnected && portSelect.value === '');
  portSelect.disabled = isConnected;
  refreshBtn.disabled = isConnected;
  clearBtn.disabled = !isConnected && lineStore.length === 0;
  sendBtn.disabled = !isConnected;
  updateTagButton();
}

function updateTagButton(): void {
  const selected = window.getSelection()?.toString().trim() ?? '';
  tagBtn.disabled = selected.length === 0;
}

function setStatus(message?: string): void {
  statusEl.textContent =
    message || (state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Idle');
}

function appendLines(entries: { text: string; ts?: number }[], dropCount: number): void {
  dropOldest(dropCount);
  for (const entry of entries) {
    decisions.push(matchLine(entry.text, tags, filterMode));
    if (decisions[decisions.length - 1].visible) {
      visibleIndexes.push(lineStore.length);
    }
    lineStore.push(entry);
  }
  scheduleRender();
  if (scroll === 'follow') {
    // Pin to the bottom after the window re-renders with the new content.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }
  updateButtons();
}

function restyleAllRows(): void {
  for (let i = 0; i < lineStore.length; i++) {
    decisions[i] = matchLine(lineStore[i].text, tags, filterMode);
  }
  rebuildVisibleIndexes();
  scheduleRender();
}

function renderChips(): void {
  tagsRow.textContent = '';
  tagsRow.style.display = tags.length ? 'flex' : 'none';
  for (const t of tags) {
    const chip = document.createElement('button');
    chip.className = `chip${t.enabled ? '' : ' chip-off'}`;
    chip.style.borderColor = t.color;
    chip.style.background = t.enabled ? `${t.color}33` : 'transparent';
    chip.textContent = t.name;
    chip.title = t.enabled ? `Hide matches of "${t.name}"` : `Highlight matches of "${t.name}"`;
    chip.addEventListener('click', () => vscode.postMessage({ type: 'toggleTag', name: t.name }));
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
  for (const t of tags) {
    const row = document.createElement('div');
    row.className = 'tag-edit-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'tag-name';
    nameInput.value = t.name;
    nameInput.title = 'Tag name';
    nameInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', name: t.name, patch: { name: nameInput.value } });
    });

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'tag-pattern';
    patternInput.value = t.pattern;
    patternInput.placeholder = 'Match pattern (substring or regex source)';
    patternInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', name: t.name, patch: { pattern: patternInput.value } });
    });

    const regexLabel = document.createElement('label');
    const regexInput = document.createElement('input');
    regexInput.type = 'checkbox';
    regexInput.checked = t.isRegex;
    regexInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', name: t.name, patch: { isRegex: regexInput.checked } });
    });
    regexLabel.appendChild(regexInput);
    regexLabel.appendChild(document.createTextNode('regex'));

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = t.color;
    colorInput.addEventListener('change', () => {
      vscode.postMessage({ type: 'updateTag', name: t.name, patch: { color: colorInput.value } });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tag-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = `Delete tag "${t.name}"`;
    deleteBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeTag', name: t.name });
    });

    row.append(nameInput, patternInput, regexLabel, colorInput, deleteBtn);
    managePanel.appendChild(row);
  }
  if (!tags.length) {
    managePanel.textContent = 'No tags yet — select text in the output and press “+ Tag”.';
  }
}

manageToggleBtn.addEventListener('click', () => {
  manageOpen = !manageOpen;
  renderManagePanel();
});

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'ports') {
    fillPorts(m.ports);
    updateButtons();
  } else if (m.type === 'state') {
    state = m.state;
    updateButtons();
    setStatus(m.message);
  } else if (m.type === 'append') {
    appendLines(m.lines.map((text: string, i: number) => ({ text, ts: m.timestamps?.[i] })), m.dropCount);
  } else if (m.type === 'timestamps') {
    showTimestamps = m.enabled;
    timestampsCheckbox.checked = m.enabled; // keep the checkbox in sync with the setting
    scheduleRender();
  } else if (m.type === 'clear') {
    clearMonitor();
  } else if (m.type === 'lineEnding') {
    lineEndingSelect.value = m.value;
  } else if (m.type === 'tags') {
    tags = m.tags;
    renderChips();
    restyleAllRows();
  }
});

connectBtn.addEventListener('click', () => {
  if (state === 'connecting') {
    return;
  }
  if (state === 'connected') {
    vscode.postMessage({ type: 'disconnect' });
    return;
  }
  const path = portSelect.value;
  if (!path) {
    return;
  }
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
  const text = sendInput.value;
  if (state !== 'connected') {
    return;
  }
  sendInput.value = '';
  vscode.postMessage({ type: 'send', text, lineEnding: lineEndingSelect.value });
}

sendBtn.addEventListener('click', sendCurrent);
sendInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendCurrent();
  }
});

const timestampsCheckbox = document.getElementById('timestamps') as HTMLInputElement;
timestampsCheckbox.addEventListener('change', () => {
  vscode.postMessage({ type: 'setTimestamps', enabled: timestampsCheckbox.checked });
});

function clearMonitor(): void {
  clearBuffer();
  scroll = scrollReducer(scroll, { type: 'reset' });
  renderScrollIndicator();
  updateButtons();
}

clearBtn.addEventListener('click', clearMonitor);

// Scroll Lock: user scrolls drive the follow/locked reducer; programmatic
// pinning only ever scrolls to the bottom, which keeps Follow.
log.addEventListener('scroll', () => {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const next = scrollReducer(scroll, { type: 'scrolled', atBottom });
  if (next !== scroll) {
    scroll = next;
    renderScrollIndicator();
  }
  scheduleRender();
});

scrollStateBtn.addEventListener('click', () => {
  scroll = scrollReducer(scroll, { type: 'toggle' });
  if (scroll === 'follow') {
    log.scrollTop = log.scrollHeight; // rejoining the stream snaps to the bottom
  }
  renderScrollIndicator();
});

function renderScrollIndicator(): void {
  scrollStateBtn.innerHTML = scroll === 'follow' ? '&#8681; Following' : '&#128274; Locked';
  scrollStateBtn.title =
    scroll === 'follow'
      ? 'Viewport follows new lines — click to lock'
      : 'Scroll locked, data keeps arriving — click to rejoin';
  scrollStateBtn.classList.toggle('locked', scroll === 'locked');
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

// Filtering is display-layer only (ADR-0004): switching modes recomputes
// visibility and never changes the Follow/locked state.
filterSelect.addEventListener('change', () => {
  filterMode = filterSelect.value as FilterMode;
  restyleAllRows();
});

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshPorts' });
});

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', scheduleRender);

measureRowHeight();
renderScrollIndicator();
scheduleRender();
vscode.postMessage({ type: 'ready' });
