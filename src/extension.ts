import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';

import {
  LineEnding as ApiLineEnding,
  MonitorPortSettings,
  Port,
  PortInformation,
  SerialMonitorApi,
  StopBits,
  Version,
} from './api/serialMonitorApi';
import { ControllerState, HostToWebview, MonitorController, TimedLine } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { LineEnding, SerialPortSettings } from './host/serialPortAdapter';
import { TagStorage, TagStore } from './host/tagStore';
import { Tag } from './shared/tag';
import { formatTimestamp } from './shared/timestamp';
import { monitorPageHtml } from './webview/monitorPage';

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number; dataBits: number; stopBits: number; parity: string }
  | { type: 'disconnect'; sessionId: number }
  | { type: 'closeSession'; sessionId: number }
  | { type: 'openLogFile' }
  | { type: 'clear'; sessionId?: number }
  | { type: 'send'; sessionId: number; text: string; lineEnding: string }
  | { type: 'setTimestamps'; enabled: boolean }
  | { type: 'setLogSession'; sessionId: number; enabled: boolean }
  | { type: 'chooseLogDirectory' }
  | { type: 'clearLogDirectory' }
  | { type: 'export'; sessionId: number }
  | { type: 'exportData'; sessionId: number; entries: { text: string; ts?: number }[] }
  | { type: 'createTag'; pattern: string }
  | { type: 'updateTag'; id: string; patch: { name?: string; pattern?: string; isRegex?: boolean; color?: string; highlight?: boolean; filter?: boolean } }
  | { type: 'removeTag'; id: string }
  | { type: 'clearTags' };

const LINE_ENDINGS: readonly LineEnding[] = ['none', 'LF', 'CRLF', 'CR'];

function toSettings(msg: Extract<WebviewToHost, { type: 'connect' }>): SerialPortSettings {
  const dataBits = Number(msg.dataBits);
  const stopBits = Number(msg.stopBits);
  const parity = ['none', 'even', 'odd', 'mark', 'space'].includes(msg.parity)
    ? (msg.parity as SerialPortSettings['parity'])
    : 'none';
  return {
    path: String(msg.port),
    baudRate: Number(msg.baudRate) || 115200,
    dataBits: ([5, 6, 7, 8] as number[]).includes(dataBits) ? (dataBits as SerialPortSettings['dataBits']) : 8,
    stopBits: ([1, 1.5, 2] as number[]).includes(stopBits) ? (stopBits as SerialPortSettings['stopBits']) : 1,
    parity,
  };
}

function fileStamp(what: string): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${what.replace(/[^\w.-]/g, '_')}-${stamp}`;
}

function toLineEnding(value: string): LineEnding {
  return (LINE_ENDINGS as readonly string[]).includes(value) ? (value as LineEnding) : 'LF';
}

function readCap(): number {
  return vscode.workspace.getConfiguration('serialMonitor').get<number>('maxBufferLines', 10000) ?? 10000;
}

function readTimestamps(): boolean {
  return vscode.workspace.getConfiguration('serialMonitor').get<boolean>('timestamps', true) ?? true;
}

function readLogDirectory(): string {
  return vscode.workspace.getConfiguration('serialMonitor').get<string>('logDirectory', '') ?? '';
}

function readRecentBauds(): number[] {
  return vscode.workspace.getConfiguration('serialMonitor').get<number[]>('recentBaudRates', []) ?? [];
}

export function activate(
  context: vscode.ExtensionContext,
): { getApi(version: Version, extensionContext: vscode.ExtensionContext): Promise<SerialMonitorApi | undefined> } {
  const provider = new MonitorViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MonitorViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('serialMonitor.open', () => {
      void vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('serialMonitor.openLogFile', () => {
      void provider.openLogFileViaDialog();
    }),
  );

  return {
    getApi: (version: Version): Promise<SerialMonitorApi | undefined> => {
      // Version negotiation per the original contract: requesting a version
      // above what is supported yields undefined.
      if (version > Version.latest) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(new MonitorApi(provider));
    },
  };
}

export function deactivate(): void {
  // Sessions (and their ports) are disposed with their view.
}

/** A live tab in the monitor: one monitored port, or one opened log file
 * shown read-only. Port sessions own their controller and log file. */
interface PortSession {
  kind: 'port';
  id: number;
  controller: MonitorController;
  logDesired: boolean;
  sessionLogFile?: string;
}

interface FileSession {
  kind: 'file';
  id: number;
}

type ProviderSession = PortSession | FileSession;

/**
 * The monitor docks in the bottom panel as a "SERIAL MONITOR" tab, matching
 * the Microsoft Serial Monitor layout. Sessions (monitored ports and opened
 * log files) appear as tabs in the webview; the view keeps its state while
 * hidden (retainContextWhenHidden) so streaming output survives switches.
 */
class MonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'serialMonitor.view';

  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<number, ProviderSession>();
  private nextId = 1;
  private post: (msg: unknown) => void = () => undefined;
  private pendingExportId: number | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.file(path.join(this.extensionUri.fsPath, 'dist', 'media'));
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = monitorPageHtml({
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.file(path.join(mediaRoot.fsPath, 'main.js')))
        .toString(),
      cspSource: view.webview.cspSource,
    });
    view.title = 'Serial Monitor';

    const post = (msg: unknown) => {
      // The view may already be disposed when a late message arrives.
      void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
    };
    this.post = post;

    const tagStore = new TagStore(workspaceTagStorage());
    const sendDisplayState = () => {
      post({ type: 'timestamps', enabled: readTimestamps() });
    };
    const sendTags = () => {
      // The view may already be disposed when a late change arrives.
      void Promise.resolve(view.webview.postMessage({ type: 'tags', tags: tagStore.getTags() })).catch(
        () => undefined,
      );
    };
    const unsubscribeTags = tagStore.onChange(sendTags);
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('serialMonitor.tags')) {
        tagStore.reload(); // also fires sendTags via onChange
      }
      if (e.affectsConfiguration('serialMonitor.maxBufferLines')) {
        for (const s of this.sessions.values()) {
          if (s.kind === 'port') {
            s.controller.setCap(readCap());
          }
        }
      }
      if (e.affectsConfiguration('serialMonitor.timestamps')) {
        for (const s of this.sessions.values()) {
          if (s.kind === 'port') {
            s.controller.setTimestamps(readTimestamps());
          }
        }
        sendDisplayState();
      }
      if (e.affectsConfiguration('serialMonitor.logDirectory')) {
        for (const s of this.sessions.values()) {
          if (s.kind === 'port') {
            this.sendLoggingState(s);
          }
        }
      }
    });
    sendTags();

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void this.refreshPorts();
          if (msg.type === 'ready') {
            sendDisplayState();
            post({ type: 'recentBauds', values: readRecentBauds() });
          }
          break;
        case 'connect':
          void this.handleConnect(toSettings(msg));
          break;
        case 'disconnect': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            void s.controller.disconnect();
          }
          break;
        }
        case 'closeSession':
          void this.destroySession(msg.sessionId);
          break;
        case 'openLogFile':
          void this.openLogFileViaDialog();
          break;
        case 'clear': {
          if (msg.sessionId === undefined) {
            break; // the webview clears its own buffer; nothing to reset
          }
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            s.controller.resetBuffer();
          }
          break;
        }
        case 'send': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            void s.controller.sendText(String(msg.text), toLineEnding(msg.lineEnding));
          }
          break;
        }
        case 'setLogSession': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind !== 'port') {
            break;
          }
          s.logDesired = Boolean(msg.enabled);
          if (s.controller.state === 'connected') {
            if (s.logDesired) {
              void this.armSessionLog(s, s.controller.activePath ?? 'port');
            } else {
              s.sessionLogFile = undefined;
            }
            this.sendLoggingState(s);
          }
          break;
        }
        case 'setTimestamps': {
          const enabled = Boolean(msg.enabled);
          for (const s of this.sessions.values()) {
            if (s.kind === 'port') {
              s.controller.setTimestamps(enabled);
            }
          }
          // Persist through the setting so the config watcher syncs the
          // webview's display flag and the choice survives reloads.
          void updateSerialMonitorSetting('timestamps', enabled);
          break;
        }
        case 'chooseLogDirectory':
          void this.chooseLogDirectory();
          break;
        case 'clearLogDirectory':
          void updateSerialMonitorSetting('logDirectory', '');
          for (const s of this.sessions.values()) {
            if (s.kind === 'port') {
              s.sessionLogFile = undefined;
              this.sendLoggingState(s);
            }
          }
          break;
        case 'export':
          // Pull the buffered lines from the webview; completeExport opens
          // the save dialog once they arrive.
          this.pendingExportId = msg.sessionId;
          post({ type: 'exportRequest', sessionId: msg.sessionId });
          break;
        case 'exportData':
          if (this.pendingExportId === msg.sessionId) {
            this.pendingExportId = undefined;
            void this.completeExport(msg.sessionId, msg.entries);
          }
          break;
        case 'createTag':
          void tagStore.add(String(msg.pattern));
          break;
        case 'updateTag':
          void tagStore.update(String(msg.id), msg.patch);
          break;
        case 'removeTag':
          void tagStore.remove(String(msg.id));
          break;
        case 'clearTags':
          void tagStore.clearAll();
          break;
      }
    });

    view.onDidDispose(() => {
      unsubscribeTags();
      configWatcher.dispose();
      for (const id of [...this.sessions.keys()]) {
        void this.destroySession(id);
      }
      this.view = undefined;
    });
  }

  // --- Session lifecycle -----------------------------------------------------

  private async refreshPorts(): Promise<void> {
    try {
      const ports = await new NodeSerialPortBackend().listPorts();
      this.post({ type: 'ports', ports });
    } catch (err) {
      this.postMessageStatus(`Failed to list serial ports: ${describe(err)}`);
    }
  }

  private createPortSession(portPath: string): PortSession {
    const id = this.nextId++;
    const controller = new MonitorController(
      new NodeSerialPortBackend(),
      (msg: HostToWebview) => this.post({ ...msg, sessionId: id }),
      {
        maxBufferLines: readCap(),
        timestamps: readTimestamps(),
        onBatch: (entries) => {
          const s = this.sessions.get(id);
          if (s?.kind === 'port') {
            this.logEntries(s, entries, readTimestamps());
          }
        },
      },
    );
    const session: PortSession = { kind: 'port', id, controller, logDesired: Boolean(readLogDirectory()) };
    this.sessions.set(id, session);
    // Per-session log lifecycle: a configured log directory means every new
    // session logs by default; each connection writes a fresh file.
    controller.onStateChange((s) => {
      this.updateTitle();
      if (s === 'connected') {
        if (session.logDesired) {
          void this.armSessionLog(session, controller.activePath ?? 'port');
        }
      } else if (s === 'idle') {
        session.sessionLogFile = undefined;
        this.sendLoggingState(session);
      }
    });
    this.post({ type: 'sessionCreated', sessionId: id, kind: 'port', title: portPath, state: 'connecting' });
    this.sendLoggingState(session);
    return session;
  }

  private async handleConnect(settings: SerialPortSettings): Promise<void> {
    const session = this.createPortSession(settings.path);
    await session.controller.connect(settings);
    if (session.controller.state === 'connected') {
      void this.pushRecentBaud(settings.baudRate);
      return;
    }
    // The teardown already reported why the open failed through the tagged
    // state message; remove the never-connected tab.
    this.post({ type: 'sessionFailed', sessionId: session.id, message: `Could not open ${settings.path}` });
    await this.destroySession(session.id);
  }

  /** Tears a session down: disconnects its port when live, then drops it.
   * The webview usually removed the tab already; sessionClosed is a no-op
   * for it then. */
  private async destroySession(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) {
      return;
    }
    this.sessions.delete(id);
    this.updateTitle();
    if (s.kind === 'port') {
      await s.controller.disconnect();
      await s.controller.dispose();
    }
    this.post({ type: 'sessionClosed', sessionId: id });
  }

  private updateTitle(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const live: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.kind === 'port' && s.controller.state === 'connected' && s.controller.activePath) {
        live.push(s.controller.activePath);
      }
    }
    view.title =
      live.length === 0
        ? 'Serial Monitor'
        : live.length === 1
          ? `Serial Monitor: ${live[0]}`
          : `Serial Monitor (${live.length} ports)`;
  }

  // --- Open-a-log-file sessions ----------------------------------------------

  /** 📂 Picks a saved log/text file and shows it as a read-only tab. */
  async openLogFileViaDialog(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Open',
      title: 'Open a serial log file in a read-only tab',
      filters: { 'Log Files': ['log', 'txt'], 'All Files': ['*'] },
    });
    if (!picked?.length) {
      return; // user cancelled
    }
    await this.openLogFile(picked[0]);
  }

  async openLogFile(uri: vscode.Uri): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    }
    let content: string;
    try {
      content = await fs.readFile(uri.fsPath, 'utf-8');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}: ${describe(err)}`);
      return;
    }
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop(); // trailing newline, not an empty record
    }
    // The buffer cap applies like a live stream: keep the newest lines.
    const cap = readCap();
    const dropCount = Math.max(0, lines.length - cap);
    const kept = dropCount > 0 ? lines.slice(-cap) : lines;

    const id = this.nextId++;
    this.sessions.set(id, { kind: 'file', id });
    this.post({
      type: 'sessionCreated',
      sessionId: id,
      kind: 'file',
      title: path.basename(uri.fsPath),
      state: 'idle',
    });
    for (let i = 0; i < kept.length; i += 2000) {
      this.post({ type: 'append', sessionId: id, lines: kept.slice(i, i + 2000), dropCount: i === 0 ? dropCount : 0 });
    }
  }

  // --- Public-API surface -----------------------------------------------------

  /** Starts monitoring through a new port session; resolves to a Port whose
   * onClosed fires when the connection drops for any reason. */
  async startMonitoringPort(settings: MonitorPortSettings): Promise<Port> {
    await this.ensureView();
    for (const s of this.sessions.values()) {
      if (s.kind === 'port' && s.controller.state !== 'idle') {
        throw new Error(
          'A monitor is already active; multiple simultaneous monitors are not supported in this version.',
        );
      }
    }
    const apiSettings = toApiSettings(settings);
    const session = this.createPortSession(settings.port);
    const closed = new vscode.EventEmitter<void>();
    const unsub = session.controller.onStateChange((s) => {
      if (s === 'idle') {
        unsub();
        closed.fire();
      }
    });
    await session.controller.connect(apiSettings);
    // Read through a cast: TypeScript's alias narrowing of the getter gets
    // this comparison wrong across the awaited connect() above.
    const stateAfterConnect = session.controller.state as ControllerState;
    if (stateAfterConnect !== 'connected') {
      unsub();
      closed.dispose();
      this.post({ type: 'sessionFailed', sessionId: session.id, message: `Could not open ${settings.port}` });
      await this.destroySession(session.id);
      throw new Error(`Failed to open ${settings.port}. See the monitor view for details.`);
    }
    const view = this.view;
    if (view) {
      void Promise.resolve(
        view.webview.postMessage({ type: 'lineEnding', value: apiLineEndingToUi(settings.lineEnding) }),
      ).catch(() => undefined);
    }
    return {
      stopMonitoring: async () => {
        unsub();
        await session.controller.disconnect(); // the tab stays with its buffer
      },
      onClosed: closed.event,
    };
  }

  async stopMonitoringPort(portName: string): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (s.kind === 'port' && s.controller.state === 'connected' && s.controller.activePath === portName) {
        await s.controller.disconnect();
        return true;
      }
    }
    return false;
  }

  clearMonitorOutput(): void {
    this.post({ type: 'clear' });
  }

  // --- Session logging --------------------------------------------------------

  private sendLoggingState(session: PortSession): void {
    this.post({
      type: 'logging',
      sessionId: session.id,
      active: session.sessionLogFile !== undefined,
      fileName: session.sessionLogFile ? path.basename(session.sessionLogFile) : undefined,
      directory: readLogDirectory() || undefined,
      desired: session.logDesired,
    });
  }

  /** Arms a session's log file: the configured directory if present,
   * otherwise a save dialog. Called on connect / mid-session toggle. */
  private async armSessionLog(session: PortSession, portPath: string): Promise<void> {
    const dir = readLogDirectory();
    if (dir) {
      session.sessionLogFile = path.join(dir, `serial-${fileStamp(portPath)}.log`);
      this.sendLoggingState(session);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`serial-${fileStamp(portPath)}.log`),
      title: 'Save this session serial log to',
      filters: { 'Log Files': ['log'], 'Text Files': ['txt'] },
    });
    if (!target) {
      return; // user cancelled; session stays unlogged
    }
    session.sessionLogFile = target.fsPath;
    this.sendLoggingState(session);
  }

  private async pushRecentBaud(baudRate: number): Promise<void> {
    const next = [baudRate, ...readRecentBauds().filter((b) => b !== baudRate)].slice(0, 5);
    await updateSerialMonitorSetting('recentBaudRates', next);
    this.post({ type: 'recentBauds', values: next });
  }

  /** 📁 Picks the directory every session logs into (right-click clears). */
  private async chooseLogDirectory(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Log here',
      title: 'Choose the directory for per-session serial logs',
    });
    if (!picked?.length) {
      return;
    }
    await updateSerialMonitorSetting('logDirectory', picked[0].fsPath);
    for (const s of this.sessions.values()) {
      if (s.kind === 'port') {
        this.sendLoggingState(s);
      }
    }
    this.postMessageStatus(`Log directory: ${picked[0].fsPath} — each session writes a new .log file`);
  }

  /** 📤 Exports a session's buffer: the webview hands us its lines, then we
   * ask where to put them. */
  private async completeExport(sessionId: number, entries: readonly { text: string; ts?: number }[]): Promise<void> {
    if (entries.length === 0) {
      this.postMessageStatus('Nothing to export.');
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = folder
      ? vscode.Uri.joinPath(folder, `serial-export-${fileStamp('export')}.log`)
      : vscode.Uri.file(`serial-export-${fileStamp('export')}.log`);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      title: 'Export the buffered log to',
      filters: { 'Log Files': ['log'], 'Text Files': ['txt'] },
    });
    if (!target) {
      return; // user cancelled the dialog
    }
    const withTimestamps = readTimestamps();
    const text = entries
      .map((e) => (withTimestamps ? `[${formatTimestamp(e.ts ?? Date.now())}] ${e.text}` : e.text))
      .join('\n') + '\n';
    try {
      await fs.writeFile(target.fsPath, text, 'utf-8');
      this.postMessageStatus(`Exported ${entries.length} lines to ${path.basename(target.fsPath)}`);
    } catch (err) {
      this.postMessageStatus(`Export failed: ${describe(err)}`);
    }
  }

  private logEntries(session: PortSession, entries: readonly TimedLine[], withTimestamps: boolean): void {
    const file = session.sessionLogFile;
    if (!file || entries.length === 0) {
      return;
    }
    const text = entries
      .map((e) => (withTimestamps ? `[${formatTimestamp(e.ts)}] ${e.text}` : e.text))
      .join('\n') + '\n';
    fs.appendFile(file, text, 'utf-8').catch((err: unknown) => {
      session.sessionLogFile = undefined;
      this.sendLoggingState(session);
      this.postMessageStatus(`Logging stopped: ${describe(err)}`);
    });
  }

  /** Status-line ping without a session (dialog results, export outcomes). */
  private postMessageStatus(message: string): void {
    this.post({ type: 'status', message });
  }

  private async ensureView(): Promise<void> {
    if (this.view) {
      return;
    }
    await vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    const deadline = Date.now() + 5000;
    while (!this.view && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.view) {
      throw new Error('The serial monitor view did not initialize.');
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspaceTagStorage(): TagStorage {
  const read = (): Tag[] | undefined =>
    vscode.workspace.getConfiguration('serialMonitor').get<Tag[]>('tags');
  return {
    get: read,
    update: async (tags) => {
      await updateSerialMonitorSetting('tags', tags);
    },
  };
}

/** Writes a serialMonitor setting, falling back to user scope when no
 * folder is open (workspace-scope updates need a folder). */
async function updateSerialMonitorSetting(key: string, value: unknown): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('serialMonitor').update(key, value, target);
}

function toApiSettings(ms: MonitorPortSettings): SerialPortSettings {
  return {
    path: ms.port,
    baudRate: ms.baudRate,
    dataBits: ms.dataBits,
    stopBits: ms.stopBits === StopBits.Two ? 2 : ms.stopBits === StopBits.Onepointfive ? 1.5 : 1,
    parity: ms.parity,
  };
}

function apiLineEndingToUi(le: ApiLineEnding): string {
  switch (le) {
    case ApiLineEnding.LF:
      return 'LF';
    case ApiLineEnding.CRLF:
      return 'CRLF';
    case ApiLineEnding.CR:
      return 'CR';
    default:
      return 'none';
  }
}

/** The SerialMonitorApi implementation over the monitor view's sessions. */
class MonitorApi implements SerialMonitorApi {
  constructor(private readonly provider: MonitorViewProvider) {}

  async listAvailablePorts(): Promise<PortInformation[]> {
    const ports = await new NodeSerialPortBackend().listPorts();
    return ports.map((p) => ({ portName: p.path, friendlyName: p.description }));
  }

  startMonitoringPort(monitorSettings: MonitorPortSettings): Promise<Port> {
    return this.provider.startMonitoringPort(monitorSettings);
  }

  async stopMonitoringPort(portName: string): Promise<boolean> {
    return this.provider.stopMonitoringPort(portName);
  }

  startMonitoringTCPConnection(): Promise<Port> {
    // ADR-0002: TCP stays on the API surface but reports unsupported until it ships.
    return Promise.reject(
      new Error('TCP monitoring is not supported by this version of Serial Monitor (OSS).'),
    );
  }

  async stopMonitoringTCPConnection(): Promise<boolean> {
    return false;
  }

  async clearOutput(): Promise<void> {
    this.provider.clearMonitorOutput();
  }

  dispose(): void {}
}
