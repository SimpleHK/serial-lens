/**
 * The webview page for the bottom-panel "SERIAL MONITOR" tab. Layout mirrors
 * the Microsoft Serial Monitor: a config row (Monitor Mode, Port with
 * refresh, Baud rate), an action row (Start/Stop Monitoring, Clear,
 * Tag-from-selection), the tag chip row, and a dark console area. The client
 * script is the esbuild-bundled dist/media/main.js (shared tag modules run
 * here); the send bar and Line ending control arrive with the base-monitor
 * ticket and are deliberately absent until then.
 */

import { BAUD_RATE_PRESETS, DEFAULT_BAUD_RATE } from '../shared/baudPresets';

export function monitorPageHtml(options: { scriptUri: string; cspSource: string }): string {
  const { scriptUri, cspSource } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource};">
<title>Serial Monitor</title>
<style>
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; }
  #config-row { border-bottom: 1px solid var(--vscode-panel-border); }
  #connect { margin-left: auto; }
  .baud-wrap { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .baud-menu { display: none; position: absolute; top: 100%; left: 0; z-index: 10; max-height: 220px; overflow-y: auto; min-width: 130px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
  .baud-item { padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .baud-item:hover { background: var(--vscode-list-hoverBackground); }
  .baud-item.recent::before { content: '937\FE0E '; color: var(--vscode-descriptionForeground); }
  #params-row { border-bottom: 1px solid var(--vscode-panel-border); padding-top: 4px; padding-bottom: 4px; }
  .tag-add { padding: 2px 10px; }
  #log-file.logging { background: var(--vscode-charts-red, #f14c4c); color: #ffffff; }
  label { color: var(--vscode-descriptionForeground); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  #mode { min-width: 90px; }
  #port { flex: 1; min-width: 180px; }
  #baud { min-width: 90px; width: 90px; }
  #send-row { border-top: 1px solid var(--vscode-panel-border); }
  #send-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); }
  #send-row button:disabled { opacity: 0.5; cursor: default; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; }
  button:hover:enabled { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); }
  .icon-btn { font-size: 18px; padding: 3px 9px; line-height: 1; min-width: 38px; text-align: center; vertical-align: middle; }
  .primary-action { margin-left: auto; font-weight: 600; }
  #clear, #create-tag { padding: 4px 8px; }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  #scroll-state.locked { background: var(--vscode-inputValidation-warningBackground, #5a5a30); }
  #tags-row { border-bottom: 1px solid var(--vscode-panel-border); }
  .chip { border: 1px solid; border-radius: 12px; padding: 2px 12px; font-size: 1em; }
  .chip-off { opacity: 0.45; text-decoration: line-through; }
  #manage-panel { display: none; flex-direction: column; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tag-edit-row { display: flex; gap: 6px; align-items: center; }
  .tag-edit-row input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 2px 4px; }
  .tag-edit-row .tag-name { width: 120px; }
  .tag-edit-row .tag-pattern { flex: 1; }
  .tag-edit-row input[type="color"] { width: 28px; height: 22px; padding: 0; border: none; background: none; }
  .tag-edit-row label { white-space: nowrap; }
  .tag-edit-row .tag-delete { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; }
  #log { flex: 1; overflow-y: auto; overflow-x: auto; padding: 4px 10px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); user-select: text; }
  .log-spacer { width: 1px; }
  #log .row-line { height: 20px; line-height: 20px; white-space: pre; width: max-content; min-width: 100%; }
</style>
</head>
<body>
  <div id="hw-row" class="row">
    <label for="mode">Monitor Mode</label>
    <select id="mode" disabled><option selected>Serial</option></select>
    <label for="port">Port</label>
    <select id="port"></select>
    <button id="refresh" class="secondary icon-btn" title="Refresh port list">&#128260;</button>
    <label for="baud">Baud rate</label>
    <span class="baud-wrap">
      <input id="baud" value="115200" inputmode="numeric">
      <button id="baud-toggle" class="secondary icon-btn" title="Quick-pick baud rate">&#9662;</button>
      <div id="baud-menu"></div>
    </span>
    <label for="data-bits">Data bits</label>
    <select id="data-bits"><option value="8" selected>8</option><option value="7">7</option></select>
    <label for="parity">Parity</label>
    <select id="parity"><option value="none" selected>None</option><option value="even">Even</option><option value="odd">Odd</option></select>
    <label for="stop-bits">Stop bits</label>
    <select id="stop-bits"><option value="1" selected>1</option><option value="2">2</option></select>
    <label for="line-ending">Line ending</label>
    <select id="line-ending"><option value="LF" selected>LF</option><option value="CRLF">CRLF</option><option value="CR">CR</option><option value="none">None</option></select>
    <button id="connect" class="primary-action">&#9654; Start Monitoring</button>
  </div>
  <div id="content-row" class="row">
    <button id="collapse-hw" class="secondary icon-btn" title="Hide the hardware row">&#9652;</button>
    <button id="clear" class="secondary icon-btn" title="Clear monitor">&#128465;&#65039;</button>
    <button id="create-tag" class="secondary icon-btn" disabled title="Create a tag from the selected text">&#127991;&#65039;</button>
    <button id="manage-toggle" class="secondary icon-btn" title="Manage tags">&#9881;&#65039;</button>
    <label for="filter">Filter</label>
    <select id="filter"><option value="off" selected>Off</option><option value="include">Include</option><option value="exclude">Exclude</option></select>
    <label for="timestamps">Timestamps</label>
    <input id="timestamps" type="checkbox">
    <label for="log-session">Log to file</label>
    <input id="log-session" type="checkbox">
    <button id="log-dir" class="secondary icon-btn" title="Choose a log directory: every logged session writes a new .log file (right-click to clear)">&#128193;</button>
    <button id="export-log" class="secondary icon-btn" disabled title="Export the buffered log to a file">&#128228;</button>
    <button id="scroll-state" class="secondary">&#8681; Following</button>
    <span id="status">Idle</span>
  </div>
  <div id="tags-row" class="row" style="display: none;"></div>
  <div id="manage-panel" style="display: none;"></div>
  <div id="log"></div>
  <div id="send-row" class="row">
    <input id="send-input" placeholder="Type in a message to send to the serial port...">
    <button id="send">Send</button>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

