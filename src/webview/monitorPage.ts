/**
 * The webview page for the bottom-panel "SERIAL MONITOR" tab. Layout mirrors
 * the Microsoft Serial Monitor: a config row (Monitor Mode, Port with
 * refresh, Baud rate), an action row (Start/Stop Monitoring, Clear), and a
 * dark console area. The send bar and Line ending control arrive with the
 * base-monitor ticket and are deliberately absent until then.
 */
const BAUD_RATE_PRESETS = [
  300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 500000,
  921600, 1000000, 2000000,
];
const DEFAULT_BAUD_RATE = 115200;

export function monitorPageHtml(): string {
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
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; }
  #config-row { border-bottom: 1px solid var(--vscode-panel-border); }
  label { color: var(--vscode-descriptionForeground); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  #mode { min-width: 90px; }
  #port { flex: 1; min-width: 180px; }
  #baud { min-width: 100px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
  button:hover:enabled { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #clear { padding: 4px 8px; }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  #log { flex: 1; overflow-y: auto; padding: 4px 10px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  #log .row-line { min-height: 1.25em; }
</style>
</head>
<body>
  <div id="config-row" class="row">
    <label for="mode">Monitor Mode</label>
    <select id="mode" disabled><option selected>Serial</option></select>
    <label for="port">Port</label>
    <select id="port"></select>
    <button id="refresh" class="secondary" title="Refresh port list">&#8635;</button>
    <label for="baud">Baud rate</label>
    <select id="baud">${baudOptions}</select>
  </div>
  <div id="action-row" class="row">
    <button id="connect">&#9654; Start Monitoring</button>
    <button id="clear" class="secondary" title="Clear monitor">&#128465;</button>
    <span id="status">Idle</span>
  </div>
  <div id="log"></div>
  <script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();
    var portSelect = document.getElementById('port');
    var baudSelect = document.getElementById('baud');
    var connectBtn = document.getElementById('connect');
    var clearBtn = document.getElementById('clear');
    var refreshBtn = document.getElementById('refresh');
    var statusEl = document.getElementById('status');
    var log = document.getElementById('log');
    var state = 'idle';

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
      portSelect.disabled = state === 'connected';
      for (var i = 0; i < ports.length; i++) {
        var o = document.createElement('option');
        o.value = ports[i].path;
        o.textContent = ports[i].description
          ? ports[i].path + ' - ' + ports[i].description
          : ports[i].path;
        portSelect.appendChild(o);
      }
    }

    function updateButtons() {
      var isConnected = state === 'connected';
      var isConnecting = state === 'connecting';
      connectBtn.innerHTML = isConnected ? '&#9632; Stop Monitoring' : '&#9654; Start Monitoring';
      connectBtn.disabled = isConnecting || (!isConnected && portSelect.value === '');
      portSelect.disabled = isConnected;
      refreshBtn.disabled = isConnected;
      clearBtn.disabled = !isConnected && log.childElementCount === 0;
    }

    function setStatus(message) {
      statusEl.textContent = message ||
        (state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Idle');
    }

    function appendLines(lines) {
      var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var row = document.createElement('div');
        row.className = 'row-line';
        row.textContent = lines[i];
        frag.appendChild(row);
      }
      log.appendChild(frag);
      if (atBottom) { log.scrollTop = log.scrollHeight; }
      updateButtons();
    }

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (m.type === 'ports') { fillPorts(m.ports); updateButtons(); }
      else if (m.type === 'state') { state = m.state; updateButtons(); setStatus(m.message); }
      else if (m.type === 'append') { appendLines(m.lines); }
    });

    connectBtn.addEventListener('click', function () {
      if (state === 'connecting') { return; }
      if (state === 'connected') { vscode.postMessage({ type: 'disconnect' }); return; }
      var path = portSelect.value;
      if (!path) { return; }
      vscode.postMessage({ type: 'connect', port: path, baudRate: Number(baudSelect.value) });
    });

    clearBtn.addEventListener('click', function () {
      log.textContent = '';
      updateButtons();
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
