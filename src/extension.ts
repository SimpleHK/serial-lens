import * as vscode from 'vscode';

import { HostToWebview, MonitorController } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { monitorPageHtml } from './webview/monitorPage';

type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number }
  | { type: 'disconnect' };

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MonitorViewProvider();
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
  // Controllers and their ports are disposed with their views.
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = monitorPageHtml();
    view.title = 'Serial Monitor';

    const controller = new MonitorController(new NodeSerialPortBackend(), (msg: HostToWebview) => {
      if (msg.type === 'state') {
        view.title = msg.state === 'connected' && msg.path ? `Serial Monitor: ${msg.path}` : 'Serial Monitor';
      }
      // The view may already be disposed when a late batch arrives.
      void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
    });
    this.controller = controller;

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
      }
    });

    view.onDidDispose(() => {
      void controller.dispose();
      if (this.controller === controller) {
        this.controller = undefined;
        this.view = undefined;
      }
    });
  }
}
