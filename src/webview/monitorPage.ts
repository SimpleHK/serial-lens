/**
 * The webview page for the bottom-panel "SERIAL MONITOR" tab. Layout mirrors
 * the Microsoft Serial Monitor: a config row (Monitor Mode, Port with
 * refresh, Baud rate), a session tab strip (one tab per monitored port or
 * opened log file), an action row (Start/Stop Monitoring, Clear, Tag,
 * iconized Filter / Timestamps / Log-to-file controls), the tag chip row,
 * and a console area with a highlight-marks strip along its right edge.
 * The client script is the esbuild-bundled dist/media/main.js (shared tag
 * modules run here).
 */

export function monitorPageHtml(options: { scriptUri: string; cspSource: string }): string {
  const { scriptUri, cspSource } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${cspSource};">
<title>Serial Monitor</title>
<style>
  :root { --sm-ctl-h: 24px; --sm-radius: 4px; }
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; }
  #hw-row { border-bottom: 1px solid var(--vscode-panel-border); }
  #content-row { border-bottom: 1px solid var(--vscode-panel-border); }
  label { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
  select, input[type="text"], #baud, #send-input {
    height: var(--sm-ctl-h); box-sizing: border-box; font-size: 13px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid transparent; border-radius: var(--sm-radius); padding: 0 8px; outline: none;
    font-family: inherit; font-size: inherit;
  }
  select:hover, #baud:hover, #send-input:hover { border-color: var(--vscode-dropdown-border); }
  select:focus, #baud:focus, #send-input:focus { border-color: var(--vscode-focusBorder); }
  select { cursor: pointer; }
  #port { flex: 0 1 340px; min-width: 200px; max-width: 420px; }
  #baud { width: 88px; text-align: right; font-variant-numeric: tabular-nums; }
  button {
    height: var(--sm-ctl-h); display: inline-flex; align-items: center; justify-content: center; gap: 4px; font-size: 13px;
    background: transparent; color: var(--vscode-foreground); border: none; border-radius: var(--sm-radius);
    padding: 0 8px; cursor: pointer; font-family: inherit; font-size: var(--vscode-font-size);
  }
  button:hover:enabled { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: 0.4; cursor: default; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .primary-action { background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-left: auto; padding: 0 12px; font-weight: 600; }
  .primary-action:hover:enabled { background: var(--vscode-button-hoverBackground); }
  .icon-btn { width: 28px; min-width: 28px; padding: 0; font-size: 16px; }
  /* Toggled-on icon controls: accent tint marks the active state that the
   * removed checkbox labels used to carry. */
  .icon-btn.on { color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  #log-session.on { color: var(--vscode-foreground); }
  #scroll-state { color: var(--vscode-descriptionForeground); }
  #scroll-state.locked { color: var(--vscode-charts-yellow, #ddb100); }
  #log-dir.logging { color: var(--vscode-charts-red, #f14c4c); }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .baud-wrap { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .baud-menu {
    display: none; position: absolute; top: calc(100% + 3px); left: 0; z-index: 10;
    min-width: 100%; width: max-content; max-height: 240px; overflow-y: auto;
    background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-dropdown-border));
    border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); padding: 4px;
  }
  .baud-menu-header { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); padding: 4px 8px 2px; user-select: none; }
  .baud-item { padding: 4px 10px; border-radius: 3px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 13px; }
  .baud-item:hover { background: var(--vscode-list-hoverBackground); }
  .baud-item.current { color: var(--vscode-focusBorder); }
  .baud-item.recent::after { content: '937'; margin-left: 6px; color: var(--vscode-descriptionForeground); }
  #tabs-row { display: none; gap: 4px; align-items: center; padding: 4px 10px 0 10px; border-bottom: 1px solid var(--vscode-panel-border); overflow-x: auto; }
  .tab { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 10px; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; color: var(--vscode-descriptionForeground); cursor: pointer; white-space: nowrap; max-width: 260px; overflow: hidden; user-select: none; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tab.active { color: var(--vscode-foreground); background: var(--vscode-editor-background); border-color: var(--vscode-panel-border); position: relative; top: 1px; }
  .tab .tab-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.5; flex: none; }
  .tab .tab-dot.live { background: var(--vscode-charts-green, #89d185); opacity: 1; }
  .tab .tab-dot.pending { background: var(--vscode-charts-yellow, #ddb100); opacity: 1; }
  .tab .tab-title { overflow: hidden; text-overflow: ellipsis; }
  .tab .tab-close { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; font-size: 13px; color: inherit; opacity: 0.7; }
  .tab .tab-close:hover { background: rgba(128, 128, 128, 0.35); opacity: 1; }
  .tab-new { justify-content: center; width: 26px; padding: 0; font-weight: 600; }
  .tab-new:hover { color: var(--vscode-foreground); }
  #tags-row { border-bottom: 1px solid var(--vscode-panel-border); }
  .chip { border: 1px solid; border-radius: 999px; padding: 2px 12px; font-size: 1em; height: auto; }
  .chip:hover:enabled { filter: brightness(1.2); }
  .chip-off { opacity: 0.45; }
  .chip .seg { font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 4px; opacity: 0.35; cursor: pointer; user-select: none; }
  .chip .seg.on { opacity: 1; background: rgba(255, 255, 255, 0.18); }
  .panel-hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #manage-panel { display: none; flex-direction: column; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tag-edit-row { display: flex; gap: 6px; align-items: center; }
  .tag-edit-row input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--sm-radius); height: var(--sm-ctl-h); padding: 0 6px; }
  .tag-edit-row .tag-name { width: 120px; }
  .tag-edit-row .tag-pattern { flex: 1; }
  .tag-edit-row input[type="color"] { width: 28px; height: 22px; padding: 0; border: none; background: none; }
  .tag-edit-row label { white-space: nowrap; }
  .tag-edit-row .tag-delete { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 0 8px; }
  .tag-add { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 0 10px; }
  #log-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
  /* Microsoft-terminal gray for received data: the console area reads as
   * output, not UI chrome, in both dark and light themes. */
  #log { flex: 1; overflow-y: auto; overflow-x: auto; padding: 4px 14px 4px 10px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); user-select: text; scrollbar-width: thin; color: #cccccc; }
  body.vscode-light #log { color: #3b3b3b; }
  body.vscode-high-contrast #log { color: var(--vscode-editor-foreground); }
  #log::-webkit-scrollbar { width: 8px; height: 8px; }
  #log::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.35); border-radius: 4px; }
  #log::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.55); }
  .log-spacer { width: 1px; }
  #log .row-line { height: 20px; line-height: 20px; white-space: pre; width: max-content; min-width: 100%; }
  .log-empty { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); padding: 14px 10px; }
  /* Highlight overview strip: one colored block per tag-highlighted line,
   * squashed to the viewport height like the editor's overview ruler. */
  #log-marks { display: none; position: absolute; top: 4px; bottom: 4px; right: 13px; width: 4px; z-index: 5; cursor: pointer; }
  #log-marks .mark { position: absolute; left: 0; width: 100%; min-height: 2px; border-radius: 1px; opacity: 0.85; }
  #send-row { border-top: 1px solid var(--vscode-panel-border); }
  #send-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--sm-radius); font-family: var(--vscode-editor-font-family, monospace); }
  #send-row button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: var(--sm-radius); padding: 0 12px; }
  #send-row button:disabled { opacity: 0.4; }
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
      <div id="baud-menu" class="baud-menu"></div>
    </span>
    <label for="data-bits">Data bits</label>
    <select id="data-bits"><option value="8" selected>8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option></select>
    <label for="parity">Parity</label>
    <select id="parity"><option value="none" selected>None</option><option value="even">Even</option><option value="odd">Odd</option><option value="mark">Mark</option><option value="space">Space</option></select>
    <label for="stop-bits">Stop bits</label>
    <select id="stop-bits"><option value="1" selected>1</option><option value="1.5">1.5</option><option value="2">2</option></select>
    <label for="line-ending">Line ending</label>
    <select id="line-ending"><option value="LF" selected>LF</option><option value="CRLF">CRLF</option><option value="CR">CR</option><option value="none">None</option></select>
    <button id="connect" class="primary-action">&#9654; Start Monitoring</button>
  </div>
  <div id="tabs-row"></div>
  <div id="content-row" class="row">
    <button id="collapse-hw" class="secondary icon-btn" title="Hide the hardware row">&#9652;</button>
    <button id="clear" class="secondary icon-btn" title="Clear monitor">&#129529;</button>
    <button id="create-tag" class="secondary icon-btn" disabled title="Create a tag from the selected text">&#127991;&#65039;</button>
    <button id="manage-toggle" class="secondary icon-btn" title="Manage tags">&#9881;&#65039;</button>
    <span class="baud-wrap">
      <button id="filter-toggle" class="secondary icon-btn" title="Filter lines by tags">&#128269;</button>
      <div id="filter-menu" class="baud-menu"></div>
    </span>
    <button id="timestamps" class="secondary icon-btn" title="Timestamps: off">&#9201;&#65039;</button>
    <button id="log-session" class="secondary icon-btn" title="Log to file: off">&#9898;&#65039;</button>
    <button id="log-dir" class="secondary icon-btn" title="Choose a log directory: every logged session writes a new .log file (right-click to clear)">&#128193;</button>
    <button id="open-log-file" class="secondary icon-btn" title="Open a log file in a read-only tab">&#128194;</button>
    <button id="export-log" class="secondary icon-btn" disabled title="Export the buffered log to a file">&#128228;</button>
    <button id="scroll-state" class="secondary">&#8681; Following</button>
    <span id="status">Idle</span>
  </div>
  <div id="tags-row" class="row" style="display: none;"></div>
  <div id="manage-panel" style="display: none;"></div>
  <div id="log-wrap">
    <div id="log"></div>
    <div id="log-marks" title="Highlighted lines — click to jump"></div>
  </div>
  <div id="send-row" class="row">
    <input id="send-input" placeholder="Type in a message to send to the serial port...">
    <button id="send">Send</button>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
