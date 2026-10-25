import * as path from 'node:path';
import * as vscode from 'vscode';

import { HostToWebview, MonitorController } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { TagStorage, TagStore } from './host/tagStore';
import { Tag } from './shared/tag';
import { monitorPageHtml } from './webview/monitorPage';

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number }
  | { type: 'disconnect' }
  | { type: 'createTag'; pattern: string }
  | { type: 'toggleTag'; name: string };

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

    const controller = new MonitorController(new NodeSerialPortBackend(), (msg: HostToWebview) => {
      if (msg.type === 'state') {
        view.title = msg.state === 'connected' && msg.path ? `Serial Monitor: ${msg.path}` : 'Serial Monitor';
      }
      // The view may already be disposed when a late batch arrives.
      void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
    });
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
    });
    sendTags();

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void controller.refreshPorts();
          break;
        case 'connect':
          void controller.connect(String(msg.port), Number(msg.baudRate));
          break;
        case 'disconnect':
          void controller.disconnect();
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
      await vscode.workspace
        .getConfiguration('serialMonitor')
        .update('tags', tags, vscode.ConfigurationTarget.Workspace);
    },
  };
}
