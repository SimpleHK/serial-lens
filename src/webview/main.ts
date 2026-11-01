declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

import { LineDecision, matchLine } from '../shared/tagMatching';
import { FilterMode, Tag } from '../shared/tag';
import { scrollReducer, ScrollState } from '../shared/scrollState';
import { BAUD_RATE_PRESETS, DEFAULT_BAUD_RATE } from '../shared/baudPresets';
import { formatLineText } from '../shared/lineText';
import { HostToWebview, SerialParams, WebviewToHost } from '../shared/protocol';
import { buildFindRegex, FindOccurrence, scanOccurrences, stepIndex } from './findCore';
import { computeRenderWindow } from './windowMath';
import { rowHeightFor } from './rowHeight';

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

const panesArea = document.getElementById('panes') as HTMLDivElement;

/**
 * Layout: there is no global toolbar. Every pane carries its own serial
 * config and actions in its bar, plus its OWN copy of the global controls
 * (add monitor, refresh, filter, timestamps, log dir, open file, tag,
 * manage) and a per-pane status readout; the empty-state row carries one
 * too. Nothing re-parents on focus — focus only steers Ctrl+F, the API
 * clear, and transient status messages. ＋ opens a port quick-pick.
 */

/** Per-pane DOM. Config controls exist only on port panes. */
interface PaneDom {
  root: HTMLDivElement;
  bar: HTMLDivElement;
  dot: HTMLSpanElement;
  title: HTMLSpanElement;
  play?: HTMLButtonElement;
  sendToggle?: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  logBtn?: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  scrollBtn: HTMLButtonElement;
  findBtn: HTMLButtonElement;
  close: HTMLSpanElement;
  portSelect?: HTMLSelectElement;
  baudInput?: HTMLInputElement;
  dbSel?: HTMLSelectElement;
  paritySel?: HTMLSelectElement;
  sbSel?: HTMLSelectElement;
  leSel?: HTMLSelectElement;
  log: HTMLDivElement;
  marks: HTMLDivElement;
  findMarks: HTMLDivElement;
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
  hint: HTMLDivElement;
  /** This pane's own copy of the global controls and its status readout. */
  globalSeg: HTMLDivElement;
  status: HTMLSpanElement;
  ctlRefs: {
    tagBtn: HTMLButtonElement;
    filterToggleBtn: HTMLButtonElement;
    timestampsBtn: HTMLButtonElement;
    logDirBtn: HTMLButtonElement;
  };
  /** Per-pane virtualization spacers. They MUST NOT be shared: replaceChildren
   * moves nodes, so a module-level pair would be stolen by whichever pane
   * rendered last, collapsing the other pane's scrollable height. */
  spacerTop: HTMLDivElement;
  spacerBottom: HTMLDivElement;
}

interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  error: boolean;
  occurrences: FindOccurrence[];
  current: number;
  byLine: Map<number, FindOccurrence[]>;
  debounce: number | undefined;
}

/** Per-pane serial settings: captured at creation, edited through the pane's
 * own controls, and used verbatim when the pane (re)starts. */
type PortSettings = SerialParams;

const DEFAULT_PORT_SETTINGS: PortSettings = {
  baudRate: DEFAULT_BAUD_RATE,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

interface PaneSession {
  id: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  message?: string;
  settings?: PortSettings;
  lineEnding: string;
  sendCollapsed: boolean;
  lineStore: { text: string; ts?: number }[];
  decisions: LineDecision[];
  visibleIndexes: number[];
  scroll: ScrollState;
  logDesired: boolean;
  logFile?: string;
  logDirectory?: string;
  find: FindState;
  /** Transient status text (export results etc.): shown for a few seconds,
   * then the iconized state returns. */
  transientMessage?: string;
  transientUntil?: number;
  transientTimer?: number;
  dom: PaneDom;
  lastRender?: { topPx: number; bottomPx: number; rows: RenderedRow[] };
  marksDirty: boolean;
  dividerLeft?: HTMLDivElement;
  sendHistory: string[];
  sendIndex: number;
  sendDraft: string;
}

const sessions: PaneSession[] = [];
let focusedId: number | undefined;
// A pane's ▶ restarts itself: the old pane closes only after the new session
// actually connects. Two-phase tracking keeps a failed open from stranding
// the request (an unrelated session must never close the old pane).
let pendingReplaceOldId: number | undefined;
let pendingReplaceNewId: number | undefined;

// Display-layer globals shared by every pane.
let filterMode: FilterMode = 'off';
let showTimestamps = false;
let tags: Tag[] = [];
let recentBauds: number[] = [];
let lastPorts: { path: string; description?: string }[] = [];

function focusedSession(): PaneSession | undefined {
  return sessions.find((s) => s.id === focusedId);
}

// Every pane (and the empty row) carries its OWN copy of the global
// controls; the registries let state changes restyle all copies at once.
const controlRegistry = {
  tagButtons: new Set<HTMLButtonElement>(),
  filterToggles: new Set<HTMLButtonElement>(),
  timestampsButtons: new Set<HTMLButtonElement>(),
  logDirButtons: new Set<HTMLButtonElement>(),
};
let emptyStatus: HTMLSpanElement | undefined;
let emptyAddMenu: HTMLDivElement | undefined;

function unregisterControls(ctlRefs?: PaneDom['ctlRefs']): void {
  if (!ctlRefs) {
    return;
  }
  controlRegistry.tagButtons.delete(ctlRefs.tagBtn);
  controlRegistry.filterToggles.delete(ctlRefs.filterToggleBtn);
  controlRegistry.timestampsButtons.delete(ctlRefs.timestampsBtn);
  controlRegistry.logDirButtons.delete(ctlRefs.logDirBtn);
}

/** Builds one copy of the global controls: ＋ port menu, refresh, filter,
 * timestamps, log dir, open file, tag, manage, and a status readout. */
function buildGlobalControls(): {
  seg: HTMLDivElement;
  status: HTMLSpanElement;
  addMonitorBtn: HTMLButtonElement;
  filterToggleBtn: HTMLButtonElement;
  timestampsBtn: HTMLButtonElement;
  logDirBtn: HTMLButtonElement;
  tagBtn: HTMLButtonElement;
} {
  const seg = document.createElement('div');
  seg.className = 'global-seg';
  const mkBtn = (cls: string, glyph: string, title: string) => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = glyph;
    b.title = title;
    seg.appendChild(b);
    return b;
  };

  // ＋ with its own port quick-pick.
  const addWrap = document.createElement('span');
  addWrap.className = 'menu-wrap';
  const addMonitorBtn = document.createElement('button');
  addMonitorBtn.className = 'icon-btn add-monitor';
  addMonitorBtn.innerHTML = '&#65291;';
  addMonitorBtn.title = 'Add a monitor — pick a port';
  const addMenu = document.createElement('div');
  addMenu.className = 'menu add-menu';
  addWrap.append(addMonitorBtn, addMenu);
  seg.appendChild(addWrap);
  addMonitorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddMenu(addMenu);
  });

  const refreshBtn = mkBtn('icon-btn refresh-btn', '&#128260;', 'Refresh port list');
  refreshBtn.addEventListener('click', () => {
    post({ type: 'refreshPorts' });
  });

  // Filter mode menu (funnel glyph).
  const filterWrap = document.createElement('span');
  filterWrap.className = 'menu-wrap';
  const filterToggleBtn = document.createElement('button');
  filterToggleBtn.className = 'icon-btn filter-toggle';
  filterToggleBtn.setAttribute('aria-label', 'Filter');
  filterToggleBtn.title = 'Filter';
  const glyph = document.createElement('span');
  glyph.className = 'filter-glyph';
  glyph.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18l-7 8.5V19l-4 2.5v-8.5L3 4z" fill="currentColor"/></svg>';
  filterToggleBtn.appendChild(glyph);
  const filterMenu = document.createElement('div');
  filterMenu.className = 'menu filter-menu';
  filterWrap.append(filterToggleBtn, filterMenu);
  seg.appendChild(filterWrap);
  filterToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (filterMenu.style.display === 'block') {
      filterMenu.style.display = 'none';
      return;
    }
    renderFilterMenu(filterMenu);
    filterMenu.style.display = 'block';
  });

  const timestampsBtn = mkBtn('icon-btn timestamps', '&#9201;&#65039;', 'Timestamps: off');
  timestampsBtn.addEventListener('click', () => {
    post({ type: 'setTimestamps', enabled: !showTimestamps });
  });

  const logDirBtn = mkBtn('icon-btn log-dir', '&#128193;', 'Choose a log directory: every logged session writes a new .log file (right-click to clear)');
  logDirBtn.addEventListener('click', () => {
    post({ type: 'chooseLogDirectory' });
  });
  logDirBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    post({ type: 'clearLogDirectory' });
  });

  const openLogFileBtn = mkBtn('icon-btn open-log-file', '&#128194;', 'Open a log file in a read-only pane');
  openLogFileBtn.addEventListener('click', () => {
    post({ type: 'openLogFile' });
  });

  const tagBtn = mkBtn('icon-btn create-tag', '&#127991;&#65039;', 'Create a tag from the selected text');
  tagBtn.disabled = true;
  tagBtn.addEventListener('click', () => {
    const selected = window.getSelection()?.toString().trim() ?? '';
    if (!selected) {
      return;
    }
    post({ type: 'createTag', pattern: selected });
  });
  // Keep the selection alive: clicking the button must not collapse it.
  tagBtn.addEventListener('mousedown', (e) => e.preventDefault());

  const manageToggleBtn = mkBtn('icon-btn manage-toggle', '&#9881;&#65039;', 'Manage tags');
  manageToggleBtn.addEventListener('click', () => {
    manageOpen = !manageOpen;
    renderManagePanel();
  });

  const status = document.createElement('span');
  status.className = 'pane-status';
  status.textContent = 'Idle';
  seg.appendChild(status);

  controlRegistry.tagButtons.add(tagBtn);
  controlRegistry.filterToggles.add(filterToggleBtn);
  controlRegistry.timestampsButtons.add(timestampsBtn);
  controlRegistry.logDirButtons.add(logDirBtn);

  return { seg, status, addMonitorBtn, filterToggleBtn, timestampsBtn, logDirBtn, tagBtn };
}

function toggleAddMenu(menu: HTMLDivElement): void {
  if (menu.style.display === 'block') {
    menu.style.display = 'none';
    return;
  }
  renderAddMenu(menu);
  menu.style.display = 'block';
  // Refresh the cached list in the background; reopening shows it.
  post({ type: 'refreshPorts' });
}

/** Baud quick-pick content: recently used rates first, then every preset. */
function renderBaudMenuInto(menu: HTMLDivElement, input: HTMLInputElement): void {
  menu.textContent = '';
  const push = (b: number, recent: boolean) => {
    const item = document.createElement('div');
    item.className = 'menu-item' + (recent ? ' recent' : '');
    item.textContent = (String(b) === input.value.trim() ? '✔︎ ' : '') + String(b);
    item.title = recent ? 'Recently used' : '';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      input.value = String(b);
      input.dispatchEvent(new Event('change'));
      menu.classList.remove('visible');
    });
    menu.appendChild(item);
  };
  const header = (label: string) => {
    const h = document.createElement('div');
    h.className = 'menu-header';
    h.textContent = label;
    menu.appendChild(h);
  };
  let shown = 0;
  if (recentBauds.length) {
    header('Recent');
    for (const b of recentBauds) {
      push(b, true);
      shown++;
    }
    header('Presets');
  }
  for (const b of BAUD_RATE_PRESETS) {
    if (recentBauds.includes(b)) {
      continue;
    }
    push(b, false);
    shown++;
  }
  if (shown === 0) {
    header('No presets');
  }
}

function renderAddMenu(menu: HTMLDivElement): void {
  menu.textContent = '';
  const header = document.createElement('div');
  header.className = 'menu-header';
  header.textContent = 'Add monitor — pick a port';
  menu.appendChild(header);
  if (!lastPorts.length) {
    const hint = document.createElement('div');
    hint.className = 'menu-item hint';
    hint.textContent = 'No ports detected — press 🔄 to refresh';
    menu.appendChild(hint);
    return;
  }
  for (const p of lastPorts) {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.dataset.path = p.path;
    item.textContent = p.description ? `${p.path} — ${p.description}` : p.path;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      startFromMenu(p.path);
    });
    menu.appendChild(item);
  }
}

// Virtualized rendering: fixed-height rows, spacer divs hold the scrolled
// distance so only the visible window (plus overscan) exists in the DOM.
const OVERSCAN_ROWS = 20;
let rowHeightPx = 20;
const pendingRenders = new Set<PaneSession>();
let renderScheduled = false;

// CSS Custom Highlight API (Chromium ≥105, guaranteed in VS Code's webview);
// guarded lookups keep TypeScript's DOM lib happy.
type HighlightLike = { new (...ranges: Range[]): unknown };
const highlightCtor = (window as unknown as { Highlight?: HighlightLike }).Highlight;
const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

function measureRowHeight(logEl: HTMLElement): void {
  // Derive the row height from the editor font size and publish it to CSS —
  // see rowHeight.ts for why the two must be one integer value.
  const fontSize = parseFloat(window.getComputedStyle(logEl).fontSize) || 13;
  const h = rowHeightFor(fontSize);
  document.documentElement.style.setProperty('--sm-row-h', `${h}px`);
  const probe = document.createElement('div');
  probe.className = 'row-line';
  probe.style.visibility = 'hidden';
  probe.textContent = 'X';
  logEl.appendChild(probe);
  rowHeightPx = probe.offsetHeight || h;
  probe.remove();
}

function renderText(entry: { text: string; ts?: number }): string {
  return formatLineText(entry, showTimestamps);
}

function renderWindowFor(s: PaneSession): void {
  pendingRenders.delete(s);
  const logEl = s.dom.log;
  const total = s.visibleIndexes.length;
  const { first, last } = computeRenderWindow(logEl.scrollTop, logEl.clientHeight, rowHeightPx, total, OVERSCAN_ROWS);

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
 * line, squashed to the viewport like the editor's overview ruler. */
function renderMarksFor(s: PaneSession): void {
  if (!s.marksDirty) {
    return;
  }
  s.marksDirty = false;
  const total = s.visibleIndexes.length;
  const height = Math.max(1, s.dom.log.clientHeight - 8);
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

/** Find-match ticks in the secondary overview strip. */
function renderFindMarksFor(s: PaneSession): void {
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
  const buckets = new Map<number, number>();
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

function recomputeOccurrences(s: PaneSession): void {
  const f = s.find;
  f.occurrences = [];
  f.byLine = new Map();
  f.error = false;
  if (f.open && f.query) {
    const re = buildFindRegex(f);
    if (!re) {
      f.error = true;
    } else {
      f.occurrences = scanOccurrences(re, s.visibleIndexes, (li) => renderText(s.lineStore[li]));
      for (const occ of f.occurrences) {
        let list = f.byLine.get(occ.lineIndex);
        if (!list) {
          list = [];
          f.byLine.set(occ.lineIndex, list);
        }
        list.push(occ);
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

function renderFindCount(s: PaneSession): void {
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

function jumpToCurrent(s: PaneSession): void {
  const occ = s.find.occurrences[s.find.current];
  if (!occ) {
    return;
  }
  const p = s.visibleIndexes.indexOf(occ.lineIndex);
  if (p >= 0) {
    s.dom.log.scrollTop = Math.max(0, p * rowHeightPx - s.dom.log.clientHeight / 2);
  }
}

function navigateFind(s: PaneSession, dir: 1 | -1): void {
  const f = s.find;
  if (!f.occurrences.length) {
    return;
  }
  f.current = stepIndex(f.current, f.occurrences.length, dir);
  jumpToCurrent(s);
  renderFindCount(s);
  refreshFindHighlights();
}

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

function openFind(s: PaneSession): void {
  s.find.open = true;
  s.dom.findBar.classList.add('visible');
  s.dom.findInput.focus();
  s.dom.findInput.select();
  recomputeOccurrences(s);
}

function closeFind(s: PaneSession): void {
  s.find.open = false;
  s.find.query = '';
  s.dom.findInput.value = '';
  s.dom.findBar.classList.remove('visible');
  recomputeOccurrences(s);
}

function scheduleFindRecompute(s: PaneSession): void {
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
    return;
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

function scheduleRender(s: PaneSession): void {
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

function rebuildVisibleIndexes(s: PaneSession): void {
  s.visibleIndexes = [];
  for (let i = 0; i < s.decisions.length; i++) {
    if (s.decisions[i].visible) {
      s.visibleIndexes.push(i);
    }
  }
}

function dropOldest(s: PaneSession, count: number): void {
  if (count <= 0) {
    return;
  }
  s.lineStore.splice(0, count);
  s.decisions.splice(0, count);
  rebuildVisibleIndexes(s);
  s.marksDirty = true;
}

function appendToSession(s: PaneSession, entries: { text: string; ts?: number }[], dropCount: number): void {
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
    scheduleFindRecompute(s);
  }
  if (s.scroll === 'follow') {
    requestAnimationFrame(() => {
      s.dom.log.scrollTop = s.dom.log.scrollHeight;
    });
  }
  refreshPaneControls(s);
}

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

function updateTagButton(): void {
  const selected = window.getSelection()?.toString().trim() ?? '';
  for (const btn of controlRegistry.tagButtons) {
    btn.disabled = selected.length === 0;
    btn.title = selected
      ? `Create a tag from "${selected.length > 24 ? selected.slice(0, 24) + '…' : selected}"`
      : 'Create a tag from the selected text (or type one in the ⚙ panel)';
  }
}

function renderTimestampsControl(): void {
  for (const btn of controlRegistry.timestampsButtons) {
    btn.classList.toggle('on', showTimestamps);
    btn.title = `Timestamps: ${showTimestamps ? 'on' : 'off'} — click to ${showTimestamps ? 'hide' : 'show'} them`;
  }
}

function stateText(s: PaneSession): string {
  return s.state === 'connected' ? 'Connected' : s.state === 'connecting' ? 'Connecting...' : 'Idle';
}

/** The pane's status readout: an iconized connection state (✔/⌛/○, title
 * carries the full text) unless a transient message is on display. */
function renderPaneStatus(s: PaneSession): void {
  const el = s.dom.status;
  const text = s.message || stateText(s);
  el.title = text;
  if (s.transientMessage && s.transientUntil !== undefined && Date.now() < s.transientUntil) {
    el.textContent = s.transientMessage;
    return;
  }
  s.transientMessage = undefined;
  el.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'status-icon';
  icon.dataset.state = s.state;
  icon.textContent = s.state === 'connected' ? '✔' : s.state === 'connecting' ? '⌛' : '○';
  el.appendChild(icon);
}

function renderEmptyStatus(message?: string): void {
  if (!emptyStatus) {
    return;
  }
  if (message) {
    emptyStatus.textContent = message;
    emptyStatus.title = message;
    return;
  }
  const live = sessions.filter((s) => s.kind === 'port' && s.state === 'connected').length;
  const text = live ? `${live} monitor${live > 1 ? 's' : ''} running` : 'Idle';
  emptyStatus.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'status-icon';
  icon.dataset.state = 'idle';
  icon.textContent = '○';
  emptyStatus.appendChild(icon);
  emptyStatus.title = text;
}

/** Transient messages go to the focused pane's status for a few seconds,
 * then the iconized state returns; otherwise the empty row's status shows
 * the summary. */
function setStatus(message?: string): void {
  const f = focusedSession();
  if (f) {
    if (message) {
      f.transientMessage = message;
      f.transientUntil = Date.now() + 4000;
      if (f.transientTimer !== undefined) {
        clearTimeout(f.transientTimer);
      }
      f.transientTimer = setTimeout(() => {
        f.transientTimer = undefined;
        renderPaneStatus(f);
      }, 4100) as unknown as number;
    }
    renderPaneStatus(f);
    return;
  }
  renderEmptyStatus(message);
}

function startFromMenu(path: string): void {
  // Already monitored (or connecting): focus that pane instead of failing a
  // second open.
  const live = sessions.find((x) => x.kind === 'port' && x.state !== 'idle' && x.title === path);
  if (live) {
    setFocused(live.id);
    setStatus(`${path} is already being monitored`);
    return;
  }
  // Clone the newest port pane's settings; defaults otherwise.
  const last = [...sessions].reverse().find((x) => x.kind === 'port' && x.settings)?.settings;
  const cfg = last ?? DEFAULT_PORT_SETTINGS;
  post({
    type: 'connect',
    port: path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
  });
}

// --- Split-view panes --------------------------------------------------------

function syncEmptyState(): void {
  panesArea.querySelector('.empty-row')?.remove();
  if (sessions.length === 0) {
    const row = document.createElement('div');
    row.className = 'empty-row';
    const controls = buildGlobalControls();
    const hint = document.createElement('span');
    hint.textContent = 'No monitors open — press ＋ to add one, or open a saved log file.';
    panesArea.appendChild(row);
    row.appendChild(controls.seg); // actions lead, hint follows
    row.appendChild(hint);
    emptyStatus = controls.status;
    emptyAddMenu = controls.seg.querySelector<HTMLDivElement>('.add-menu') ?? undefined;
    updateTagButton();
    renderTimestampsControl();
    renderEmptyStatus(); // iconized summary into the empty row's status
  } else {
    emptyStatus = undefined;
    emptyAddMenu = undefined;
  }
}

/** Refreshes one pane's self-contained controls from its session state. */
function refreshPaneControls(s: PaneSession): void {
  const d = s.dom;
  const isPort = s.kind === 'port';
  const isConnected = isPort && s.state === 'connected';

  d.dot.className = 'tab-dot' + (s.state === 'connected' ? ' live' : s.state === 'connecting' ? ' pending' : '');
  d.title.textContent = (s.kind === 'file' ? '\u{1F4C4} ' : '') + s.title;
  d.title.title = s.kind === 'file' ? `${s.title} (read-only log file)` : `${s.title} — ${s.state}`;
  d.root.title = d.title.title;

  if (d.play) {
    d.play.style.display = isPort ? '' : 'none';
    d.play.innerHTML = isConnected ? '&#9632;' : '&#9654;';
    d.play.classList.toggle('on', isConnected);
    d.play.title = isConnected ? `Stop monitoring ${s.title}` : `Start monitoring ${s.title}`;
    d.play.disabled = s.state === 'connecting';
  }

  d.clearBtn.disabled = s.lineStore.length === 0 && !isConnected;
  d.clearBtn.title = `Clear ${s.title}`;
  d.exportBtn.disabled = s.lineStore.length === 0;
  d.exportBtn.title = `Export ${s.title}'s buffered log to a file`;

  if (d.logBtn) {
    d.logBtn.style.display = isPort ? '' : 'none';
    const logOn = isPort && s.logDesired;
    d.logBtn.classList.toggle('on', logOn);
    d.logBtn.classList.toggle('rec', logOn);
    d.logBtn.innerHTML = logOn ? '&#128308;&#65039;' : '&#9898;&#65039;';
    if (logOn) {
      const where = s.logFile ? ` (now: ${s.logFile})` : s.logDirectory ? ` into ${s.logDirectory}` : '';
      d.logBtn.title = `Log to file: on${where} — click to stop`;
    } else {
      d.logBtn.title = 'Log to file: off — click to log this session to a .log file';
    }
  }

  d.scrollBtn.innerHTML = s.scroll === 'follow' ? '&#8681;' : '&#128274;';
  d.scrollBtn.classList.toggle('locked', s.scroll === 'locked');
  d.scrollBtn.title =
    s.scroll === 'follow'
      ? 'Viewport follows new lines — click to lock'
      : 'Scroll locked, data keeps arriving — click to rejoin';

  // Serial config: the PORT is locked while connected, but the parameters
  // stay editable — an edit reconnects the pane with the new settings
  // (MS-parity behavior). Everything locks while connecting.
  const portLocked = s.state !== 'idle';
  const paramsLocked = s.state === 'connecting';
  if (d.portSelect) {
    d.portSelect.disabled = portLocked;
    if (s.state === 'connected') {
      d.portSelect.value = s.title;
    }
  }
  if (d.baudInput) d.baudInput.disabled = paramsLocked;
  if (d.dbSel) d.dbSel.disabled = paramsLocked;
  if (d.paritySel) d.paritySel.disabled = paramsLocked;
  if (d.sbSel) d.sbSel.disabled = paramsLocked;

  // Send bar: collapsed by default, toggled per pane.
  if (d.sendToggle) {
    d.sendToggle.style.display = isPort ? '' : 'none';
    d.sendToggle.classList.toggle('on', isPort && !s.sendCollapsed);
    d.sendToggle.title = !isPort ? '' : s.sendCollapsed ? 'Show the send bar' : 'Hide the send bar';
  }
  d.sendRow.style.display = isPort && !s.sendCollapsed ? 'flex' : 'none';
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

  // This pane's own status readout (end of its controls segment).
  renderPaneStatus(s);
}

function buildPane(s: PaneSession): PaneDom {
  const root = document.createElement('div');
  root.className = 'pane';
  const bar = document.createElement('div');
  bar.className = 'pane-header';

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const title = document.createElement('span');
  title.className = 'pane-title';

  const mkBtn = (glyph: string, title: string, cls = 'pbtn') => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = glyph;
    b.title = title;
    return b;
  };
  const mkSelect = (options: string[], value: string, cls: string, ctlTitle: string) => {
    const sel = document.createElement('select');
    sel.className = `ph-ctl ${cls}`;
    sel.title = ctlTitle;
    for (const o of options) {
      const e = document.createElement('option');
      e.value = o;
      e.textContent = o;
      sel.appendChild(e);
    }
    sel.value = value;
    return sel;
  };

  const play = mkBtn('&#9654;', `Start monitoring ${s.title}`);
  const sendToggle = mkBtn('&#9000;&#65038;', 'Show the send bar');
  const clearBtn = mkBtn('&#128465;&#65039;', `Clear ${s.title}`);
  const logBtn = mkBtn('&#9898;&#65039;', 'Log to file: off');
  const exportBtn = mkBtn('&#128228;', `Export ${s.title}'s buffered log to a file`);
  const scrollBtn = mkBtn('&#8681;', 'Viewport follows new lines — click to lock');
  const findBtn = mkBtn('&#128269;', 'Find in this pane (Ctrl+F)');
  const close = document.createElement('span');
  close.className = 'pane-close';
  close.textContent = '\u00d7';
  close.title = 'Close this pane';

  let portSelect: HTMLSelectElement | undefined;
  let baudInput: HTMLInputElement | undefined;
  let dbSel: HTMLSelectElement | undefined;
  let paritySel: HTMLSelectElement | undefined;
  let sbSel: HTMLSelectElement | undefined;
  let leSel: HTMLSelectElement | undefined;

  if (s.kind === 'port') {
    title.style.display = 'none'; // the port select shows the identity
    portSelect = document.createElement('select');
    portSelect.className = 'ph-ctl ph-port';
    portSelect.title = 'Port (stop to change)';
    const opt = document.createElement('option');
    opt.value = s.title;
    opt.textContent = s.title;
    portSelect.appendChild(opt);
    portSelect.value = s.title;

    const cfg = s.settings ?? DEFAULT_PORT_SETTINGS;
    // Baud keeps a VISIBLE quick-pick (▾ menu with recents + presets) — a
    // bare native datalist regressed to an invisible single-option picker.
    const baudWrap = document.createElement('span');
    baudWrap.className = 'menu-wrap';
    baudInput = document.createElement('input');
    baudInput.className = 'ph-ctl ph-baud';
    baudInput.value = String(cfg.baudRate);
    baudInput.title = 'Baud rate';
    const baudToggle = document.createElement('button');
    baudToggle.className = 'pbtn baud-toggle';
    baudToggle.innerHTML = '&#9662;';
    baudToggle.title = 'Quick-pick baud rate';
    const baudMenu = document.createElement('div');
    baudMenu.className = 'menu baud-menu';
    baudWrap.append(baudInput, baudToggle, baudMenu);
    baudToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (baudMenu.classList.contains('visible')) {
        baudMenu.classList.remove('visible');
        return;
      }
      renderBaudMenuInto(baudMenu, baudInput!);
      baudMenu.classList.add('visible');
    });
    dbSel = mkSelect(['8', '7', '6', '5'], String(cfg.dataBits), 'ph-db', 'Data bits');
    paritySel = mkSelect(['none', 'even', 'odd', 'mark', 'space'], cfg.parity, 'ph-parity', 'Parity');
    sbSel = mkSelect(['1', '1.5', '2'], String(cfg.stopBits), 'ph-sb', 'Stop bits');
    leSel = mkSelect(['LF', 'CRLF', 'CR', 'None'], s.lineEnding, 'ph-le', 'Line ending');

    // Control edits become the pane's settings; while connected a param
    // edit also reconnects the pane with the new settings.
    const applyParams = (session: PaneSession) => {
      if (session.state === 'connected' && session.settings) {
        post({ type: 'reconnect', sessionId: session.id, settings: { ...session.settings } });
      }
    };
    baudInput.addEventListener('change', () => {
      if (s.settings) {
        s.settings.baudRate = Number(baudInput!.value) || 115200;
        applyParams(s);
      }
    });
    dbSel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.dataBits = Number(dbSel!.value) || 8;
        applyParams(s);
      }
    });
    paritySel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.parity = paritySel!.value;
        applyParams(s);
      }
    });
    sbSel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.stopBits = Number(sbSel!.value) || 1;
        applyParams(s);
      }
    });
    leSel.addEventListener('change', () => {
      s.lineEnding = leSel!.value;
    });

    bar.append(dot, title, portSelect, baudWrap, dbSel, paritySel, sbSel, leSel);
  } else {
    bar.append(dot, title);
  }

  bar.append(play, sendToggle, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close);
  root.appendChild(bar);

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

  // Port-local send bar (collapsed by default).
  const sendRow = document.createElement('div');
  sendRow.className = 'pane-send';
  const sendInput = document.createElement('input');
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  sendRow.append(sendInput, sendBtn);

  root.append(body, sendRow);
  panesArea.appendChild(root);

  root.addEventListener('click', () => setFocused(s.id));

  close.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'closeSession', sessionId: s.id });
    removeSession(s.id);
  });

  play.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.state === 'connected') {
      post({ type: 'disconnect', sessionId: s.id });
    } else if (s.state !== 'connecting') {
      startPane(s);
    }
  });

  sendToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    s.sendCollapsed = !s.sendCollapsed;
    refreshPaneControls(s);
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind === 'port') {
      post({ type: 'clear', sessionId: s.id }); // host resets its ring count too
    }
    clearBuffer(s);
  });

  logBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind !== 'port' || s.state === 'connecting') {
      return;
    }
    post({ type: 'setLogSession', sessionId: s.id, enabled: !s.logDesired });
  });

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'export', sessionId: s.id });
  });

  scrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    s.scroll = scrollReducer(s.scroll, { type: 'toggle' });
    if (s.scroll === 'follow') {
      logEl.scrollTop = logEl.scrollHeight;
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

  marks.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = marks.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    logEl.scrollTop = frac * (logEl.scrollHeight - logEl.clientHeight);
  });

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

  logEl.addEventListener('scroll', () => {
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const next = scrollReducer(s.scroll, { type: 'scrolled', atBottom });
    if (next !== s.scroll) {
      s.scroll = next;
      refreshPaneControls(s);
    }
    scheduleRender(s);
  });

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
        s.sendDraft = sendInput.value;
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

  // This pane's own copy of the global controls, at the end of its bar.
  const controls = buildGlobalControls();
  bar.appendChild(controls.seg);

  return { root, bar, dot, title, play, sendToggle, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close, portSelect, baudInput, dbSel, paritySel, sbSel, leSel, log: logEl, marks, findMarks, findBar, findInput, findCase, findWord, findRegex, findCount, findPrev, findNext, findClose, sendRow, sendInput, sendBtn, hint, spacerTop, spacerBottom, globalSeg: controls.seg, status: controls.status, ctlRefs: { tagBtn: controls.tagBtn, filterToggleBtn: controls.filterToggleBtn, timestampsBtn: controls.timestampsBtn, logDirBtn: controls.logDirBtn } };
}

function createSession(m: {
  sessionId: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  settings?: PortSettings;
}): PaneSession {
  const isFirst = sessions.length === 0;
  const s: PaneSession = {
    id: m.sessionId,
    kind: m.kind,
    title: m.title,
    state: m.state,
    settings: m.settings,
    lineEnding: 'LF',
    sendCollapsed: true,
    lineStore: [],
    decisions: [],
    visibleIndexes: [],
    scroll: 'follow',
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
    transientMessage: undefined,
    transientUntil: undefined,
    transientTimer: undefined,
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

/** Drag-resize: the divider adjusts the left pane's flex-grow weight 1:1. */
function startPaneDrag(s: PaneSession, e: MouseEvent): void {
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
  // With doubled controls there is nothing to move; focus only steers
  // Ctrl+F, the API clear, and transient status messages.
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
  unregisterControls(gone.dom.ctlRefs);
  gone.dom.root.remove();
  gone.dividerLeft?.remove();
  if (idx === 0 && sessions.length > 0) {
    sessions[0].dividerLeft?.remove();
    sessions[0].dividerLeft = undefined;
  }
  pendingRenders.delete(gone);
  if (pendingReplaceOldId === id) {
    pendingReplaceOldId = undefined;
    pendingReplaceNewId = undefined;
  }
  if (focusedId === id) {
    const next = sessions[idx] ?? sessions[idx - 1];
    setFocused(next?.id);
  }
  if (sessions.length === 0) {
    syncEmptyState(); // rebuilds the empty row with its own controls
  }
  refreshFindHighlights();
}

/** Restarts this pane's port with its OWN controls and settings. */
function startPane(s: PaneSession): void {
  if (s.kind !== 'port') {
    return;
  }
  const port = (s.dom.portSelect?.value || s.title).trim();
  pendingReplaceOldId = s.id; // replaced by the new session on success
  pendingReplaceNewId = undefined; // bound when the host reports the new session
  const cfg = s.settings ?? DEFAULT_PORT_SETTINGS;
  post({
    type: 'connect',
    port,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
  });
}

function sendCurrent(s: PaneSession): void {
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
  post({ type: 'send', sessionId: s.id, text, lineEnding: s.lineEnding });
}

function clearBuffer(s: PaneSession): void {
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
      post({ type: 'updateTag', id: t.id, patch: { highlight: !t.highlight } });
    });
    const segF = document.createElement('span');
    segF.className = 'seg' + (t.filter ? ' on' : '');
    segF.textContent = 'F';
    segF.title = t.filter ? 'Filtering ON — click to turn off' : 'Filtering OFF — click to turn on';
    segF.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'updateTag', id: t.id, patch: { filter: !t.filter } });
    });
    chip.title = `"${t.name}" — H: highlight on/off, F: filter on/off, double-click: delete`;
    chip.addEventListener('dblclick', () => post({ type: 'removeTag', id: t.id }));
    chip.append(nameSpan, segH, segF);
    tagsRow.appendChild(chip);
  }
  renderManagePanel();
}

let manageOpen = false;
let tagsRow: HTMLDivElement;
let managePanel: HTMLDivElement;

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
    post({ type: 'createTag', pattern: value });
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
    post({ type: 'clearTags' });
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
      post({ type: 'updateTag', id: t.id, patch: { name: nameInput.value } });
    });

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'tag-pattern';
    patternInput.value = t.pattern;
    patternInput.placeholder = 'Match pattern (substring or regex source)';
    patternInput.addEventListener('change', () => {
      post({ type: 'updateTag', id: t.id, patch: { pattern: patternInput.value } });
    });

    const hlLabel = document.createElement('label');
    const hlInput = document.createElement('input');
    hlInput.type = 'checkbox';
    hlInput.checked = t.highlight;
    hlInput.addEventListener('change', () => {
      post({ type: 'updateTag', id: t.id, patch: { highlight: hlInput.checked } });
    });
    hlLabel.appendChild(hlInput);
    hlLabel.appendChild(document.createTextNode('H'));

    const flLabel = document.createElement('label');
    const flInput = document.createElement('input');
    flInput.type = 'checkbox';
    flInput.checked = t.filter;
    flInput.addEventListener('change', () => {
      post({ type: 'updateTag', id: t.id, patch: { filter: flInput.checked } });
    });
    flLabel.appendChild(flInput);
    flLabel.appendChild(document.createTextNode('F'));

    const regexLabel = document.createElement('label');
    const regexInput = document.createElement('input');
    regexInput.type = 'checkbox';
    regexInput.checked = t.isRegex;
    regexInput.addEventListener('change', () => {
      post({ type: 'updateTag', id: t.id, patch: { isRegex: regexInput.checked } });
    });
    regexLabel.appendChild(regexInput);
    regexLabel.appendChild(document.createTextNode('regex'));

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = t.color;
    colorInput.addEventListener('change', () => {
      post({ type: 'updateTag', id: t.id, patch: { color: colorInput.value } });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tag-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = `Delete tag "${t.name}"`;
    deleteBtn.addEventListener('click', () => {
      post({ type: 'removeTag', id: t.id });
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

// --- Host messages -----------------------------------------------------------

function sessionFor(id: number): PaneSession | undefined {
  return sessions.find((s) => s.id === id);
}

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  if (m.type === 'ports') {
    lastPorts = m.ports;
    for (const s of sessions) {
      if (s.kind === 'port') {
        rebuildPortOptions(s);
      }
    }
    updateTagButton();
  } else if (m.type === 'state') {
    const s = sessionFor(m.sessionId);
    if (!s) {
      return;
    }
    s.state = m.state;
    s.message = m.message;
    if (m.state === 'connected' && pendingReplaceNewId === m.sessionId && pendingReplaceOldId !== undefined) {
      // The pane's ▶ restart went live: close the pane it replaces.
      const replacedId = pendingReplaceOldId;
      pendingReplaceOldId = undefined;
      pendingReplaceNewId = undefined;
      post({ type: 'closeSession', sessionId: replacedId });
      removeSession(replacedId);
    }
    refreshPaneControls(s);
    if (s.id === focusedId) {
      setStatus();
    }
  } else if (m.type === 'append') {
    const s = sessionFor(m.sessionId);
    if (s) {
      appendToSession(s, m.lines.map((text: string, i: number) => ({ text, ts: m.timestamps?.[i] })), m.dropCount);
    }
  } else if (m.type === 'timestamps') {
    showTimestamps = m.enabled;
    renderTimestampsControl();
    for (const s of sessions) {
      s.marksDirty = true;
      scheduleRender(s);
      if (s.find.open) {
        recomputeOccurrences(s);
      }
    }
  } else if (m.type === 'logging') {
    const s = sessionFor(m.sessionId);
    if (!s) {
      return;
    }
    s.logDesired = Boolean(m.desired);
    s.logFile = m.fileName;
    s.logDirectory = m.directory;
    for (const btn of controlRegistry.logDirButtons) {
      btn.classList.toggle('logging', Boolean(m.directory));
      btn.title = m.directory
        ? `Logging each session into ${m.directory} — right-click to clear`
        : 'Choose a log directory: every logged session writes a new .log file (right-click to clear)';
    }
    refreshPaneControls(s);
  } else if (m.type === 'recentBauds') {
    recentBauds = m.values; // baud menus render from this when opened
  } else if (m.type === 'exportRequest') {
    const s = sessionFor(m.sessionId);
    if (s) {
      post({ type: 'exportData', sessionId: s.id, entries: s.lineStore });
    }
  } else if (m.type === 'status') {
    setStatus(m.message);
  } else if (m.type === 'clear') {
    // API-triggered clear targets the focused pane; pane buttons send their
    // own message with a sessionId.
    const f = focusedSession();
    if (f) {
      if (f.kind === 'port') {
        post({ type: 'clear', sessionId: f.id });
      }
      clearBuffer(f);
    }
  } else if (m.type === 'lineEnding') {
    // The public API set a line ending for the session it just started.
    const s = sessionFor(m.sessionId);
    if (s && s.kind === 'port') {
      s.lineEnding = m.value;
      if (s.dom.leSel) {
        s.dom.leSel.value = m.value;
      }
    }
  } else if (m.type === 'tags') {
    tags = m.tags;
    renderChips();
    restyleAllRows();
  } else if (m.type === 'sessionCreated') {
    if (pendingReplaceOldId !== undefined && pendingReplaceNewId === undefined) {
      pendingReplaceNewId = m.sessionId; // bind the created session to the restart request
    }
    createSession(m);
  } else if (m.type === 'sessionFailed') {
    if (pendingReplaceNewId === m.sessionId) {
      // The restart's open failed: keep the old pane and its buffer.
      pendingReplaceOldId = undefined;
      pendingReplaceNewId = undefined;
    }
    const wasFocused = focusedId === m.sessionId;
    removeSession(m.sessionId);
    if (wasFocused || focusedId === undefined) {
      setStatus(m.message);
    }
  } else if (m.type === 'sessionClosed') {
    removeSession(m.sessionId);
  }
});

function rebuildPortOptions(s: PaneSession): void {
  const sel = s.dom.portSelect;
  if (!sel) {
    return;
  }
  const current = sel.value || s.title;
  sel.textContent = '';
  const paths = new Set(lastPorts.map((p) => p.path));
  if (!paths.has(current)) {
    // Keep the pane's identity visible even if the port vanished.
    const o = document.createElement('option');
    o.value = current;
    o.textContent = current;
    sel.appendChild(o);
  }
  for (const p of lastPorts) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.description ? `${p.path} — ${p.description}` : p.path;
    sel.appendChild(o);
  }
  sel.value = current;
  sel.disabled = s.state !== 'idle';
}

// Ctrl+F finds in the focused pane; F3 / Shift+F3 walk the matches.
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

// Filtering is display-layer only (ADR-0004): switching modes recomputes
// visibility for every pane and never changes Follow/locked state.
function setFilterMode(mode: FilterMode): void {
  filterMode = mode;
  for (const btn of controlRegistry.filterToggles) {
    btn.classList.toggle('on', mode !== 'off');
    btn.title = `Filter: ${mode === 'off' ? 'off' : mode} — click to choose`;
  }
  restyleAllRows();
}

function renderFilterMenu(filterMenu: HTMLDivElement): void {
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

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', () => {
  for (const s of sessions) {
    s.marksDirty = true;
    scheduleRender(s);
  }
});

// Click-away: close any open menu whose toggle was not the click target
// (menus now exist per pane).
document.addEventListener('click', (e) => {
  const target = e.target as Node;
  for (const menu of Array.from(document.querySelectorAll<HTMLDivElement>('.menu'))) {
    const open = menu.style.display === 'block' || menu.classList.contains('visible');
    if (open) {
      const wrap = menu.parentElement;
      if (!wrap || !wrap.contains(target)) {
        menu.style.display = 'none';
        menu.classList.remove('visible');
      }
    }
  }
});

// --- Init ----------------------------------------------------------------------

tagsRow = document.createElement('div');
tagsRow.id = 'tags-row';
managePanel = document.createElement('div');
managePanel.id = 'manage-panel';
document.body.insertBefore(tagsRow, panesArea);
document.body.insertBefore(managePanel, panesArea);
syncEmptyState();
renderTimestampsControl();
setFilterMode('off');
updateTagButton();
post({ type: 'ready' });
