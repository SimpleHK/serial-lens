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

let state: 'idle' | 'connecting' | 'connected' = 'idle';
// The three-state control arrives with the filter ticket; rendering already
// honors visibility so include/exclude only need to flip this mode.
let filterMode: FilterMode = 'off';
let scroll: ScrollState = 'follow';
let tags: Tag[] = [];

// Buffered content: one entry per received line, capped by the host which
// reports drops via dropCount. decisions[i] is the cached matching decision
// for lineStore[i]; visibleIndexes lists which lines the filter lets through.
const lineStore: string[] = [];
const decisions: LineDecision[] = [];
let visibleIndexes: number[] = [];

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

function renderText(line: string): string {
  return line;
}

function renderWindow(): void {
  renderScheduled = false;
  const total = visibleIndexes.length;
  const first = Math.max(0, Math.floor(log.scrollTop / rowHeightPx) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((log.scrollTop + log.clientHeight) / rowHeightPx) + OVERSCAN_ROWS);

  const frag = document.createDocumentFragment();
  for (let p = first; p < last; p++) {
    const lineIndex = visibleIndexes[p];
    const row = document.createElement('div');
    row.className = 'row-line';
    row.textContent = renderText(lineStore[lineIndex]);
    const color = decisions[lineIndex].highlightColor;
    row.style.background = color ? `${color}45` : '';
    frag.appendChild(row);
  }
  spacerTop.style.height = `${first * rowHeightPx}px`;
  spacerBottom.style.height = `${(total - last) * rowHeightPx}px`;
  log.replaceChildren(spacerTop, frag, spacerBottom);
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

function appendLines(lines: string[], dropCount: number): void {
  dropOldest(dropCount);
  for (const line of lines) {
    decisions.push(matchLine(line, tags, filterMode));
    if (decisions[decisions.length - 1].visible) {
      visibleIndexes.push(lineStore.length);
    }
    lineStore.push(line);
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
    decisions[i] = matchLine(lineStore[i], tags, filterMode);
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
}

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
    appendLines(m.lines, m.dropCount);
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

clearBtn.addEventListener('click', () => {
  clearBuffer();
  scroll = scrollReducer(scroll, { type: 'reset' });
  renderScrollIndicator();
  updateButtons();
});

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
