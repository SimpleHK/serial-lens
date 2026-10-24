import * as vscode from 'vscode';

import { HostToWebview, MonitorController } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';

const BAUD_RATE_PRESETS = [
  300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 500000,
  921600, 1000000, 2000000,
];
const DEFAULT_BAUD_RATE = 115200;

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
    void panel.webview.postMessage(msg);
  });

  panel.webview.html = monitorHtml();
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

function monitorHtml(): string {
  const nonce = getNonce();
  const baudOptions = BAUD_RATE_PRESETS.map(
    (b) => `<option value="${b}"${b === DEFAULT_BAUD_RATE ? ' selected' : ''}>${b}</option>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Serial Monitor</title>
<style>
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #toolbar { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  #toolbar label { color: var(--vscode-descriptionForeground); }
  #toolbar select { min-width: 150px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  #toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
  #toolbar button:hover:enabled { background: var(--vscode-button-hoverBackground); }
  #toolbar button:disabled { opacity: 0.5; cursor: default; }
  #refresh { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  #log { flex: 1; overflow-y: auto; padding: 4px 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  #log .row { min-height: 1.25em; }
</style>
</head>
<body>
  <div id="toolbar">
    <label for="port">Port</label>
    <select id="port"></select>
    <button id="refresh" title="Refresh port list">&#8635;</button>
    <label for="baud">Baud</label>
    <select id="baud">${baudOptions}</select>
    <button id="connect">Connect</button>
    <span id="status">Idle</span>
  </div>
  <div id="log"></div>
  <script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();
    var portSelect = document.getElementById('port');
    var baudSelect = document.getElementById('baud');
    var connectBtn = document.getElementById('connect');
    var refreshBtn = document.getElementById('refresh');
    var statusEl = document.getElementById('status');
    var log = document.getElementById('log');
    var connected = false;
    var connecting = false;

    function fillPorts(ports) {
      portSelect.textContent = '';
      if (!ports.length) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No serial ports detected';
        portSelect.appendChild(opt);
        portSelect.disabled = true;
        return;
      }
      portSelect.disabled = connected;
      for (var i = 0; i < ports.length; i++) {
        var o = document.createElement('option');
        o.value = ports[i].path;
        o.textContent = ports[i].path;
        portSelect.appendChild(o);
      }
    }

    function renderState(isConnected, isConnecting, message) {
      connected = isConnected;
      connecting = isConnecting;
      connectBtn.textContent = isConnected ? 'Disconnect' : 'Connect';
      connectBtn.disabled = isConnecting || (!isConnected && portSelect.value === '');
      portSelect.disabled = isConnected;
      refreshBtn.disabled = isConnected;
      statusEl.textContent = message || (isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Idle');
    }

    function appendLines(lines) {
      var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var row = document.createElement('div');
        row.className = 'row';
        row.textContent = lines[i];
        frag.appendChild(row);
      }
      log.appendChild(frag);
      if (atBottom) { log.scrollTop = log.scrollHeight; }
    }

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (m.type === 'ports') { fillPorts(m.ports); renderState(connected, connecting); }
      else if (m.type === 'state') { renderState(m.connected, m.connecting, m.message); }
      else if (m.type === 'append') { appendLines(m.lines); }
    });

    connectBtn.addEventListener('click', function () {
      if (connecting) { return; }
      if (connected) { vscode.postMessage({ type: 'disconnect' }); return; }
      var path = portSelect.value;
      if (!path) { return; }
      vscode.postMessage({ type: 'connect', port: path, baudRate: Number(baudSelect.value) });
    });

    refreshBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'refreshPorts' });
    });

    vscode.postMessage({ type: 'ready' });
  })();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
