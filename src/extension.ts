import * as path from 'node:path';
import * as vscode from 'vscode';

import { HostToWebview, MonitorController } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { TagStorage, TagStore } from './host/tagStore';
import { LineEnding, SerialPortSettings } from './host/serialPortAdapter';
import { Tag } from './shared/tag';
import { monitorPageHtml } from './webview/monitorPage';

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number; dataBits: number; stopBits: number; parity: string }
  | { type: 'disconnect' }
  | { type: 'send'; text: string; lineEnding: string }
  | { type: 'createTag'; pattern: string }
  | { type: 'toggleTag'; name: string };

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

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MonitorViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MonitorViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('serialMonitor.open', () => {
      void vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    }),
  );
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
    const controller = new MonitorController(
      new NodeSerialPortBackend(),
      (msg: HostToWebview) => {
        if (msg.type === 'state') {
          view.title = msg.state === 'connected' && msg.path ? `Serial Monitor: ${msg.path}` : 'Serial Monitor';
        }
        // The view may already be disposed when a late batch arrives.
        void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
      },
      { maxBufferLines: readCap() },
    );
    this.controller = controller;

    const tagStore = new TagStore(workspaceTagStorage());
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
    });
    sendTags();

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void controller.refreshPorts();
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
        case 'createTag':
          void tagStore.add(String(msg.pattern));
          break;
        case 'toggleTag':
          void tagStore.toggle(String(msg.name));
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
