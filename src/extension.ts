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
  context.subscriptions.push(
    vscode.commands.registerCommand('serialMonitor.open', () => {
      openMonitorPanel(context);
    }),
  );
}

export function deactivate(): void {
  // Controllers and their ports are disposed with their panels.
}

function openMonitorPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel('serialMonitor', 'Serial Monitor', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const controller = new MonitorController(new NodeSerialPortBackend(), (msg: HostToWebview) => {
    // The panel may already be disposed when a late batch arrives.
    void Promise.resolve(panel.webview.postMessage(msg)).catch(() => undefined);
  });

  panel.webview.html = monitorPageHtml();
  panel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
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
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => {
    void controller.dispose();
  }, undefined, context.subscriptions);
}
