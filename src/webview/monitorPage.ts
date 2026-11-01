/**
 * The webview page for the bottom-panel "SERIAL MONITOR" tab. Layout: a
 * config row for starting NEW monitors (Monitor Mode, Port with refresh,
 * Baud rate, serial params), a slim global row for display-wide controls
 * (filter mode, timestamps, log directory, open file, tag management), and
 * a split-view console area where EVERY pane is self-contained: pane header
 * with status dot + port-local actions (start/stop, clear, log-to-file,
 * export, follow/lock, find, close), the console with a find widget and a
 * highlight-marks strip, and a port-local send bar. The client script is
 * the esbuild-bundled dist/media/main.js (shared tag modules run here).
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
  select, input[type="text"], #baud {
    height: var(--sm-ctl-h); box-sizing: border-box; font-size: 13px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid transparent; border-radius: var(--sm-radius); padding: 0 8px; outline: none;
    font-family: inherit; font-size: inherit;
  }
  select:hover, #baud:hover { border-color: var(--vscode-dropdown-border); }
  select:focus, #baud:focus { border-color: var(--vscode-focusBorder); }
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
  /* Toggled-on icon controls: accent tint marks the active state. */
  .icon-btn.on { color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  #log-dir.logging { color: var(--vscode-charts-red, #f14c4c); }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .baud-wrap { position: relative; display: inline-flex; align-items: center; gap: 2px; }
  .menu {
    display: none; position: absolute; top: calc(100% + 3px); left: 0; z-index: 10;
    min-width: 100%; width: max-content; max-height: 240px; overflow-y: auto;
    background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-dropdown-border));
    border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); padding: 4px;
  }
  .menu-header { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); padding: 4px 8px 2px; user-select: none; }
  .menu-item { padding: 4px 10px; border-radius: 3px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 13px; }
  .menu-item:hover { background: var(--vscode-list-hoverBackground); }
  .menu-item.current { color: var(--vscode-focusBorder); }
  .menu-item.recent::after { content: '937'; margin-left: 6px; color: var(--vscode-descriptionForeground); }
  #tags-row { border-bottom: 1px solid var(--vscode-panel-border); }
  .chip { border: 1px solid; border-radius: 999px; padding: 2px 12px; font-size: 1em; height: auto; }
  .chip:hover:enabled { filter: brightness(1.2); }
  .chip-off { opacity: 0.45; }
  .chip .seg { font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 4px; opacity: 0.35; cursor: pointer; user-select: none; }
  .chip .seg.on { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.18)); }
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
  /* Split view: one self-contained pane per session, side by side; narrow
   * viewports scroll horizontally instead of crushing the consoles. Panes
   * resize via the draggable divider between them. */
  #panes { flex: 1; min-height: 0; display: flex; overflow-x: auto; background: var(--vscode-editor-background); }
  .pane { flex: 1 1 0; min-width: 340px; display: flex; flex-direction: column; min-height: 0; }
  .pane.focused { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pane-divider { flex: 0 0 1px; background: var(--vscode-panel-border); cursor: col-resize; position: relative; z-index: 6; }
  .pane-divider::after { content: ''; position: absolute; top: 0; bottom: 0; left: -3px; right: -3px; }
  body.pane-dragging { cursor: col-resize; user-select: none; }
  .pane-header { display: flex; align-items: center; gap: 3px; height: 24px; padding: 0 4px 0 8px; flex: none; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); user-select: none; cursor: default; }
  .pane-header .pane-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 2px; }
  .tab-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.5; flex: none; margin-right: 3px; }
  .tab-dot.live { background: var(--vscode-charts-green, #89d185); opacity: 1; }
  .tab-dot.pending { background: var(--vscode-charts-yellow, #ddb100); opacity: 1; }
  /* Pane-local action buttons: compact icon controls in the pane header. */
  .pbtn { width: 20px; min-width: 20px; height: 20px; padding: 0; font-size: 13px; border-radius: 3px; flex: none; }
  .pbtn.on { color: var(--vscode-focusBorder); }
  .pbtn.rec { color: var(--vscode-charts-red, #f14c4c); }
  .pbtn.locked { color: var(--vscode-charts-yellow, #ddb100); }
  .pane-close { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; font-size: 13px; color: inherit; opacity: 0.7; cursor: pointer; flex: none; }
  .pane-close:hover { background: rgba(128, 128, 128, 0.35); opacity: 1; }
  .pane-body { position: relative; flex: 1; min-height: 0; display: flex; }
  /* Microsoft-terminal gray for received data: the console area reads as
   * output, not UI chrome, in both dark and light themes. */
  .pane-log { flex: 1; overflow-y: auto; overflow-x: auto; padding: 4px 14px 4px 10px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); user-select: text; scrollbar-width: thin; color: #cccccc; }
  body.vscode-light .pane-log { color: #3b3b3b; }
  body.vscode-high-contrast .pane-log { color: var(--vscode-editor-foreground); }
  .pane-log::-webkit-scrollbar { width: 8px; height: 8px; }
  .pane-log::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.35); border-radius: 4px; }
  .pane-log::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.55); }
  .log-spacer { width: 1px; }
  /* Row height follows the editor font size (probed at runtime), so users
   * with larger editor fonts don't get clipped or overlapping lines. */
  .pane-log .row-line { height: 1.5em; line-height: 1.5em; white-space: pre; width: max-content; min-width: 100%; }
  .pane-hint { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); pointer-events: none; user-select: none; font-family: var(--vscode-font-family); }
  .log-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  /* Highlight overview strip: one colored block per tag-highlighted line,
   * squashed to the viewport height like the editor's overview ruler. */
  .log-marks { display: none; position: absolute; top: 4px; bottom: 4px; right: 13px; width: 4px; z-index: 5; cursor: pointer; }
  .log-marks .mark { position: absolute; left: 0; width: 100%; min-height: 2px; border-radius: 1px; opacity: 0.85; }
  /* Find-match ticks: a second strip left of the tag marks, like the
   * editor's find decorations in the overview ruler. */
  .find-marks { display: none; position: absolute; top: 4px; bottom: 4px; right: 19px; width: 3px; z-index: 5; cursor: pointer; }
  .find-marks .tick { position: absolute; left: 0; width: 100%; min-height: 2px; border-radius: 1px; background: rgba(255, 140, 0, 0.8); }
  /* Editor-style find widget: floats over the pane's top-right corner. */
  .find-bar { display: none; position: absolute; top: 4px; right: 26px; z-index: 8; align-items: center; gap: 4px; padding: 4px 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-dropdown-border));
    border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); }
  .find-bar.visible { display: inline-flex; }
  .find-bar input { width: 170px; height: 22px; box-sizing: border-box; padding: 0 6px; font-size: 12px; font-family: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; outline: none; }
  .find-bar input:focus { border-color: var(--vscode-focusBorder); }
  .fbtn { width: 22px; min-width: 22px; height: 22px; padding: 0; font-size: 12px; border-radius: 3px; flex: none; }
  .fbtn.on { background: var(--vscode-inputOption-activeBackground, rgba(255, 255, 255, 0.15)); color: var(--vscode-inputOption-activeForeground, var(--vscode-focusBorder)); outline: 1px solid var(--vscode-inputOption-activeBorder, transparent); }
  .find-count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 64px; text-align: center; user-select: none; }
  .find-count.error { color: var(--vscode-errorForeground, #f14c4c); }
  /* Text-level match highlights via the CSS Custom Highlight API. */
  ::highlight(sm-find) { background-color: rgba(236, 200, 96, 0.45); }
  ::highlight(sm-find-cur) { background-color: rgba(255, 140, 0, 0.65); color: #ffffff; }
  /* Port-local send bar at the bottom of each pane. */
  .pane-send { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); flex: none; }
  .pane-send input { flex: 1; height: var(--sm-ctl-h); box-sizing: border-box; font-size: 13px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--sm-radius); outline: none;
    font-family: var(--vscode-editor-font-family, monospace); padding: 0 8px; }
  .pane-send input:focus { border-color: var(--vscode-focusBorder); }
  .pane-send button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: var(--sm-radius); padding: 0 12px; flex: none; }
  .pane-send button:disabled { opacity: 0.4; }
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
      <div id="baud-menu" class="menu"></div>
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
  <div id="content-row" class="row">
    <button id="collapse-hw" class="secondary icon-btn" title="Hide the hardware row">&#9652;</button>
    <button id="add-monitor" class="secondary icon-btn" title="Open another monitor — the view splits so both consoles stay visible">&#65291;</button>
    <span class="baud-wrap">
      <button id="filter-toggle" class="secondary icon-btn" title="Filter lines by tags">&#128269;</button>
      <div id="filter-menu" class="menu"></div>
    </span>
    <button id="timestamps" class="secondary icon-btn" title="Timestamps: off">&#9201;&#65039;</button>
    <button id="log-dir" class="secondary icon-btn" title="Choose a log directory: every logged session writes a new .log file (right-click to clear)">&#128193;</button>
    <button id="open-log-file" class="secondary icon-btn" title="Open a log file in a read-only pane">&#128194;</button>
    <button id="create-tag" class="secondary icon-btn" disabled title="Create a tag from the selected text">&#127991;&#65039;</button>
    <button id="manage-toggle" class="secondary icon-btn" title="Manage tags">&#9881;&#65039;</button>
    <span id="status">Idle</span>
  </div>
  <div id="tags-row" class="row" style="display: none;"></div>
  <div id="manage-panel" style="display: none;"></div>
  <div id="panes"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
