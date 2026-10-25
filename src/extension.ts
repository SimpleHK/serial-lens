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
  | { type: 'disconnect' }
  | { type: 'send'; text: string; lineEnding: string }
  | { type: 'setTimestamps'; enabled: boolean }
  | { type: 'setLogSession'; enabled: boolean }
  | { type: 'chooseLogDirectory' }
  | { type: 'clearLogDirectory' }
  | { type: 'export' }
  | { type: 'exportData'; entries: { text: string; ts?: number }[] }
  | { type: 'createTag'; pattern: string }
  | { type: 'updateTag'; id: string; patch: { name?: string; pattern?: string; isRegex?: boolean; color?: string; highlight?: boolean; filter?: boolean } }
  | { type: 'removeTag'; id: string }
  | { type: 'clearTags' };

const LINE_ENDINGS: readonly LineEnding[] = ['none', 'LF', 'CRLF', 'CR'];

function toSettings(msg: Extract<WebviewToHost, { type: 'connect' }>): SerialPortSettings {
  const parity = msg.parity === 'even' || msg.parity === 'odd' ? msg.parity : 'none';
  return {
    path: String(msg.port),
    baudRate: Number(msg.baudRate) || 115200,
    dataBits: msg.dataBits === 7 ? 7 : 8,
    stopBits: msg.stopBits === 2 ? 2 : 1,
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
  // Controllers, stores, and their ports are disposed with their views.
}

/**
 * The monitor docks in the bottom panel as a "SERIAL MONITOR" tab, matching
 * the Microsoft Serial Monitor layout. One shared controller per view; the
 * view keeps its state while hidden (retainContextWhenHidden) so streaming
 * output survives tab switches.
 */
class MonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'serialMonitor.view';

  private view: vscode.WebviewView | undefined;
  private controller: MonitorController | undefined;
  private postMessage: (msg: unknown) => void = () => undefined;
  /** Active per-session log file; created on connect when a log directory is
   * configured, closed on disconnect. */
  private sessionLogFile: string | undefined;

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

    const readCap = () =>
      vscode.workspace.getConfiguration('serialMonitor').get<number>('maxBufferLines', 10000);
    const readTimestamps = () =>
      vscode.workspace.getConfiguration('serialMonitor').get<boolean>('timestamps', false);
    const readLogDirectory = () =>
      vscode.workspace.getConfiguration('serialMonitor').get<string>('logDirectory', '');
    const readRecentBauds = () =>
      vscode.workspace.getConfiguration('serialMonitor').get<number[]>('recentBaudRates', []);
    const post = (msg: unknown) => {
      // The view may already be disposed when a late message arrives.
      void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
    };
    const controller = new MonitorController(
      new NodeSerialPortBackend(),
      (msg: HostToWebview) => {
        if (msg.type === 'state') {
          view.title = msg.state === 'connected' && msg.path ? `Serial Monitor: ${msg.path}` : 'Serial Monitor';
        }
        post(msg);
      },
      {
        maxBufferLines: readCap(),
        timestamps: readTimestamps(),
        onBatch: (entries) => this.logEntries(entries, readTimestamps()),
      },
    );
    this.controller = controller;
    this.postMessage = post;
    this.logSessionDesired = Boolean(readLogDirectory());
    // Per-session log file lifecycle: when the user wants this session
    // logged, a fresh file is created per connection (in the configured
    // directory, or picked via save dialog); nothing written while idle.
    const stateSubscription = controller.onStateChange((s) => {
      if (s === 'connected' && this.logSessionDesired) {
        void this.armSessionLog(controller.activePath ?? 'port', readLogDirectory);
      } else if (s === 'idle') {
        this.sessionLogFile = undefined;
        this.sendLoggingState(readLogDirectory);
      }
    });

    const tagStore = new TagStore(workspaceTagStorage());
    const sendDisplayState = () => {
      void Promise.resolve(
        view.webview.postMessage({ type: 'timestamps', enabled: readTimestamps() }),
      ).catch(() => undefined);
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
        controller.setCap(readCap());
      }
      if (e.affectsConfiguration('serialMonitor.timestamps')) {
        controller.setTimestamps(readTimestamps());
        sendDisplayState();
      }
      if (e.affectsConfiguration('serialMonitor.logDirectory')) {
        this.sendLoggingState(readLogDirectory);
      }
    });
    sendTags();

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void controller.refreshPorts();
          if (msg.type === 'ready') {
            sendDisplayState();
            this.sendLoggingState(readLogDirectory);
            post({ type: 'recentBauds', values: readRecentBauds() });
          }
          break;
        case 'connect': {
          const settings = toSettings(msg);
          void controller.connect(settings).then(() => {
            if (controller.state === 'connected') {
              void this.pushRecentBaud(settings.baudRate, readRecentBauds);
            }
          });
          break;
        }
        case 'chooseLogDirectory':
          void this.chooseLogDirectory();
          break;
        case 'clearLogDirectory':
          void updateSerialMonitorSetting('logDirectory', '');
          this.sessionLogFile = undefined;
          this.sendLoggingState(readLogDirectory);
          break;
        case 'export':
          // Pull the buffered lines from the webview; completeExport opens
          // the save dialog once they arrive.
          this.pendingExport = true;
          post({ type: 'exportRequest' });
          break;
        case 'exportData':
          if (this.pendingExport) {
            this.pendingExport = false;
            void this.completeExport(msg.entries);
          }
          break;
        case 'connect':
          void controller.connect(toSettings(msg));
          break;
        case 'disconnect':
          void controller.disconnect();
          break;
        case 'send':
          void controller.sendText(String(msg.text), toLineEnding(msg.lineEnding));
          break;
        case 'setLogSession': {
          this.logSessionDesired = Boolean(msg.enabled);
          if (controller.state === 'connected') {
            if (this.logSessionDesired) {
              void this.armSessionLog(controller.activePath ?? 'port', readLogDirectory);
            } else {
              this.sessionLogFile = undefined;
            }
            this.sendLoggingState(readLogDirectory);
          }
          break;
        }
        case 'setTimestamps': {
          const enabled = Boolean(msg.enabled);
          controller.setTimestamps(enabled);
          // Persist through the setting so the config watcher syncs the
          // webview's display flag and the choice survives reloads.
          void updateSerialMonitorSetting('timestamps', enabled);
          break;
        }
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
      stateSubscription();
      configWatcher.dispose();
      void controller.dispose();
      this.sessionLogFile = undefined;
      if (this.controller === controller) {
        this.controller = undefined;
        this.view = undefined;
      }
    });
  }

  /** Starts monitoring through the view's controller; resolves to a Port
   * whose onClosed fires when the connection drops for any reason. */
  async startMonitoringPort(settings: MonitorPortSettings): Promise<Port> {
    const controller = await this.ensureController();
    if (controller.state !== 'idle') {
      throw new Error(
        'A monitor is already active; multiple simultaneous monitors are not supported in this version.',
      );
    }
    const closed = new vscode.EventEmitter<void>();
    const unsub = controller.onStateChange((s) => {
      if (s === 'idle') {
        unsub();
        closed.fire();
      }
    });
    await controller.connect(toApiSettings(settings));
    // Read through a cast: TypeScript's alias narrowing of the getter gets
    // this comparison wrong across the awaited connect() above.
    const stateAfterConnect = controller.state as ControllerState;
    if (stateAfterConnect !== 'connected') {
      unsub();
      closed.dispose();
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
        await controller.disconnect();
        closed.dispose();
      },
      onClosed: closed.event,
    };
  }

  async stopMonitoringPort(portName: string): Promise<boolean> {
    const controller = this.controller;
    if (controller && controller.state === 'connected' && controller.activePath === portName) {
      await controller.disconnect();
      return true;
    }
    return false;
  }

  clearMonitorOutput(): void {
    this.postMessage({ type: 'clear' });
  }

  private logSessionDesired = false;

  private sendLoggingState(readLogDirectory: () => string): void {
    this.postMessage({
      type: 'logging',
      active: this.sessionLogFile !== undefined,
      fileName: this.sessionLogFile ? path.basename(this.sessionLogFile) : undefined,
      directory: readLogDirectory() || undefined,
      desired: this.logSessionDesired,
    });
  }

  /** Arms this session's log file: the configured directory if present,
   * otherwise a save dialog. Called on connect / mid-session toggle. */
  private async armSessionLog(portPath: string, readLogDirectory: () => string): Promise<void> {
    const dir = readLogDirectory();
    if (dir) {
      this.sessionLogFile = path.join(dir, `serial-${fileStamp(portPath)}.log`);
      this.sendLoggingState(readLogDirectory);
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
    this.sessionLogFile = target.fsPath;
    this.sendLoggingState(readLogDirectory);
  }

  private async pushRecentBaud(baudRate: number, readRecentBauds: () => number[]): Promise<void> {
    const next = [baudRate, ...readRecentBauds().filter((b) => b !== baudRate)].slice(0, 5);
    await updateSerialMonitorSetting('recentBaudRates', next);
    this.postMessage({ type: 'recentBauds', values: next });
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
    this.postMessage({
      type: 'state',
      state: 'idle',
      message: `Log directory: ${picked[0].fsPath} — each session writes a new .log file`,
    });
  }

  /** 📤 Exports the current buffer: the webview hands us its lines, then we
   * ask where to put them. */
  private async completeExport(entries: readonly { text: string; ts?: number }[]): Promise<void> {
    if (entries.length === 0) {
      this.postMessage({ type: 'state', state: 'idle', message: 'Nothing to export.' });
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
    const withTimestamps = vscode.workspace.getConfiguration('serialMonitor').get<boolean>('timestamps', false);
    const text = entries
      .map((e) => (withTimestamps ? `[${formatTimestamp(e.ts ?? Date.now())}] ${e.text}` : e.text))
      .join('\n') + '\n';
    try {
      await fs.writeFile(target.fsPath, text, 'utf-8');
      this.postMessage({
        type: 'state',
        state: 'idle',
        message: `Exported ${entries.length} lines to ${path.basename(target.fsPath)}`,
      });
    } catch (err) {
      this.postMessage({
        type: 'state',
        state: 'idle',
        message: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private logEntries(entries: readonly TimedLine[], withTimestamps: boolean): void {
    const file = this.sessionLogFile;
    if (!file || entries.length === 0) {
      return;
    }
    const text = entries
      .map((e) => (withTimestamps ? `[${formatTimestamp(e.ts)}] ${e.text}` : e.text))
      .join('\n') + '\n';
    fs.appendFile(file, text, 'utf-8').catch((err: unknown) => {
      this.sessionLogFile = undefined;
      this.sendLoggingState(() =>
        vscode.workspace.getConfiguration('serialMonitor').get<string>('logDirectory', ''),
      );
      this.postMessage({
        type: 'state',
        state: 'idle',
        message: `Logging stopped: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }

  private pendingExport = false;

  private async ensureController(): Promise<MonitorController> {
    if (this.controller) {
      return this.controller;
    }
    await vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    const deadline = Date.now() + 5000;
    while (!this.controller && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.controller) {
      throw new Error('The serial monitor view did not initialize.');
    }
    return this.controller;
  }
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

/** The SerialMonitorApi implementation over the monitor view's controller. */
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
