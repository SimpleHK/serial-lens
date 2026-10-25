declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

import { matchLine } from '../shared/tagMatching';
import { FilterMode, Tag } from '../shared/tag';

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
const sendInput = document.getElementById('send-input') as HTMLInputElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;

let state: 'idle' | 'connecting' | 'connected' = 'idle';
// The three-state control arrives with the filter ticket; rendering already
// honors visibility so include/exclude only need to flip this mode.
let filterMode: FilterMode = 'off';
let tags: Tag[] = [];
// Index-aligned with log's child rows; kept so a tag change can restyle
// every line (filtering never discards data — ADR-0004).
const lineStore: string[] = [];

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
  clearBtn.disabled = !isConnected && log.childElementCount === 0;
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

function styleRow(row: HTMLElement, line: string): void {
  const decision = matchLine(line, tags, filterMode);
  row.style.background = decision.highlightColor ? `${decision.highlightColor}45` : '';
  row.style.display = decision.visible ? '' : 'none';
}

function appendLines(lines: string[]): void {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'row-line';
    row.textContent = line;
    lineStore.push(line);
    styleRow(row, line);
    frag.appendChild(row);
  }
  log.appendChild(frag);
  if (atBottom) {
    log.scrollTop = log.scrollHeight;
  }
  updateButtons();
}

/** Re-applies the current tag decisions to every buffered line. */
function restyleAllRows(): void {
  for (let i = 0; i < log.childElementCount; i++) {
    styleRow(log.children[i] as HTMLElement, lineStore[i]);
  }
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
    appendLines(m.lines);
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
  log.textContent = '';
  lineStore.length = 0;
  updateButtons();
});

tagBtn.addEventListener('click', () => {
  const selected = window.getSelection()?.toString().trim() ?? '';
  if (!selected) {
    return;
  }
  vscode.postMessage({ type: 'createTag', pattern: selected });
});

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshPorts' });
});

document.addEventListener('selectionchange', updateTagButton);

vscode.postMessage({ type: 'ready' });
