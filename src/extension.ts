import * as path from 'node:path';
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
import { HostToWebview, MonitorController, ControllerState } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { LineEnding, SerialPortSettings } from './host/serialPortAdapter';
import { TagStorage, TagStore } from './host/tagStore';
import { Tag } from './shared/tag';
import { monitorPageHtml } from './webview/monitorPage';

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number; dataBits: number; stopBits: number; parity: string }
  | { type: 'disconnect' }
  | { type: 'send'; text: string; lineEnding: string }
  | { type: 'setTimestamps'; enabled: boolean }
  | { type: 'createTag'; pattern: string }
  | { type: 'toggleTag'; name: string }
  | { type: 'updateTag'; name: string; patch: { name?: string; pattern?: string; isRegex?: boolean; color?: string; enabled?: boolean } }
  | { type: 'removeTag'; name: string };

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
    const controller = new MonitorController(
      new NodeSerialPortBackend(),
      (msg: HostToWebview) => {
        if (msg.type === 'state') {
          view.title = msg.state === 'connected' && msg.path ? `Serial Monitor: ${msg.path}` : 'Serial Monitor';
        }
        // The view may already be disposed when a late batch arrives.
        void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
      },
      { maxBufferLines: readCap(), timestamps: readTimestamps() },
    );
    this.controller = controller;

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
    });
    sendTags();

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void controller.refreshPorts();
          if (msg.type === 'ready') {
            sendDisplayState();
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
        case 'setTimestamps':
          controller.setTimestamps(Boolean(msg.enabled));
          break;
        case 'createTag':
          void tagStore.add(String(msg.pattern));
          break;
        case 'toggleTag':
          void tagStore.toggle(String(msg.name));
          break;
        case 'updateTag':
          void tagStore.update(String(msg.name), msg.patch);
          break;
        case 'removeTag':
          void tagStore.remove(String(msg.name));
          break;
      }
    });

    view.onDidDispose(() => {
      unsubscribeTags();
      configWatcher.dispose();
      void controller.dispose();
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
    void Promise.resolve(this.view?.webview.postMessage({ type: 'clear' })).catch(() => undefined);
  }

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
      // Without an open folder there is no workspace scope to write to; fall
      // back to the user-global setting so tags still persist.
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('serialMonitor').update('tags', tags, target);
    },
  };
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
