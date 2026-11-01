/**
 * The webview page for the bottom-panel "SERIAL MONITOR" tab.
 *
 * Variant B layout (prototype verdict, prototypes/toolbar-layout.html):
 * there is NO global toolbar. Every pane is fully self-contained — its bar
 * carries the serial config (port, baud, data bits, parity, stop bits, line
 * ending) plus the pane actions (start/stop, send toggle, clear, log-to-file,
 * export, follow/lock, find, close), and the GLOBAL actions (＋ add monitor,
 * refresh, tag filter, timestamps, log directory, open file, tag from
 * selection, manage tags, status) ride the FOCUSED pane's bar as one
 * #global-seg segment that moves with the focus. With zero panes the segment
 * sits in an empty-state row. The send bar starts collapsed. The static HTML
 * is therefore minimal: the panes area and a shared baud datalist; everything
 * else is built by dist/media/main.js.
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
  :root { --sm-radius: 4px; }
  *, *::before, *::after { box-sizing: border-box; }
  body { display: flex; flex-direction: column; height: 100vh; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  button { background: transparent; color: var(--vscode-foreground); border: none; border-radius: var(--sm-radius); cursor: pointer; font-family: inherit; }
  button:hover:enabled { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: 0.4; cursor: default; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .icon-btn { width: 30px; min-width: 30px; height: 26px; padding: 0; font-size: 17px; display: inline-flex; align-items: center; justify-content: center; }
  .icon-btn.on { color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  #log-dir.logging, .log-dir.logging { color: var(--vscode-charts-red, #f14c4c); }
  /* Funnel glyph for the tag-filter control (inline mask, tints via currentColor). */
  .filter-glyph { width: 16px; height: 16px; display: inline-block; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 4h18l-7 8.5V19l-4 2.5v-8.5L3 4z'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 4h18l-7 8.5V19l-4 2.5v-8.5L3 4z'/%3E%3C/svg%3E") center / contain no-repeat; }
  .menu-wrap { position: relative; display: inline-flex; }
  .menu {
    display: none; position: absolute; top: calc(100% + 3px); left: 0; z-index: 10;
    min-width: 120px; width: max-content; max-height: 260px; overflow-y: auto;
    background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-dropdown-border));
    border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); padding: 4px;
  }
  .menu-header { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); padding: 4px 8px 2px; user-select: none; white-space: nowrap; }
  .menu-item { padding: 4px 10px; border-radius: 3px; cursor: pointer; white-space: nowrap; font-size: 12px; }
  .menu-item:hover { background: var(--vscode-list-hoverBackground); }
  .menu-item.current { color: var(--vscode-focusBorder); }
  .menu-item.hint { color: var(--vscode-descriptionForeground); cursor: default; }
  #tags-row { display: none; gap: 8px; align-items: center; padding: 6px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); }
  .chip { border: 1px solid; border-radius: 999px; padding: 2px 12px; font-size: 1em; height: auto; background: transparent; color: var(--vscode-foreground); }
  .chip:hover:enabled { filter: brightness(1.2); }
  .chip-off { opacity: 0.45; }
  .chip .seg { font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 4px; opacity: 0.35; cursor: pointer; user-select: none; }
  .chip .seg.on { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.18)); }
  .panel-hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #manage-panel { display: none; flex-direction: column; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tag-edit-row { display: flex; gap: 6px; align-items: center; }
  .tag-edit-row input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--sm-radius); height: 24px; padding: 0 6px; }
  .tag-edit-row .tag-name { width: 120px; }
  .tag-edit-row .tag-pattern { flex: 1; }
  .tag-edit-row input[type="color"] { width: 28px; height: 22px; padding: 0; border: none; background: none; }
  .tag-edit-row label { white-space: nowrap; }
  .tag-edit-row .tag-delete { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 0 8px; }
  .tag-add { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 0 10px; }
  /* Split view: one self-contained pane per session; narrow viewports scroll. */
  #panes { flex: 1; min-height: 0; display: flex; overflow-x: auto; background: var(--vscode-editor-background); }
  .pane { flex: 1 1 0; min-width: 380px; display: flex; flex-direction: column; min-height: 0; }
  .pane.focused { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pane-divider { flex: 0 0 1px; background: var(--vscode-panel-border); cursor: col-resize; position: relative; z-index: 6; }
  .pane-divider::after { content: ''; position: absolute; top: 0; bottom: 0; left: -3px; right: -3px; }
  body.pane-dragging { cursor: col-resize; user-select: none; }
  .pane-header { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; min-height: 30px; padding: 2px 4px 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); user-select: none; }
  .pane-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 2px; color: var(--vscode-descriptionForeground); }
  .tab-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: 0.5; flex: none; margin-right: 3px; }
  .tab-dot.live { background: var(--vscode-charts-green, #89d185); opacity: 1; }
  .tab-dot.pending { background: var(--vscode-charts-yellow, #ddb100); opacity: 1; }
  /* Per-pane serial config, embedded in the pane bar. */
  .ph-ctl { height: 24px; font-size: 13px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid transparent; border-radius: 3px; padding: 0 5px; outline: none; font-family: inherit; }
  .ph-ctl:hover:enabled { border-color: var(--vscode-dropdown-border); }
  .ph-ctl:focus:enabled { border-color: var(--vscode-focusBorder); }
  select.ph-ctl { cursor: pointer; }
  .ph-port { flex: 0 1 140px; min-width: 92px; }
  .ph-baud { width: 70px; text-align: right; font-variant-numeric: tabular-nums; }
  .ph-db { width: 46px; } .ph-parity { width: 68px; } .ph-sb { width: 46px; } .ph-le { width: 58px; }
  .pbtn { width: 26px; min-width: 26px; height: 26px; padding: 0; font-size: 15px; border-radius: 3px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
  .pbtn.on { color: var(--vscode-focusBorder); }
  .pbtn.rec { color: var(--vscode-charts-red, #f14c4c); }
  .pbtn.locked { color: var(--vscode-charts-yellow, #ddb100); }
  .pane-close { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; font-size: 14px; color: inherit; opacity: 0.7; cursor: pointer; flex: none; }
  .pane-close:hover { background: rgba(128, 128, 128, 0.35); opacity: 1; }
  /* Variant B: the global actions exist on EVERY pane's bar (all controls
   * doubled) plus the empty-state row. */
  .global-seg { display: flex; align-items: center; gap: 2px; margin-left: auto; padding-left: 6px; border-left: 1px solid var(--vscode-panel-border); align-self: stretch; }
  .pane-status { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 0 4px; white-space: nowrap; }
  .empty-row { display: flex; flex: none; align-self: flex-start; width: 100%; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 30px; padding: 2px 10px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 12px; }
  /* The segment loses its pane-bar divider styling inside the empty row. */
  .empty-row .global-seg { margin-left: 0; border-left: none; align-self: center; }
  .pane-body { position: relative; flex: 1; min-height: 0; display: flex; }
  /* Microsoft-terminal gray for received data in both dark and light themes. */
  .pane-log { flex: 1; overflow-y: auto; overflow-x: auto; padding: 4px 14px 4px 10px; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); user-select: text; scrollbar-width: thin; color: #cccccc; }
  body.vscode-light .pane-log { color: #3b3b3b; }
  body.vscode-high-contrast .pane-log { color: var(--vscode-editor-foreground); }
  .pane-log::-webkit-scrollbar { width: 8px; height: 8px; }
  .pane-log::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.35); border-radius: 4px; }
  .pane-log::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.55); }
  .log-spacer { width: 1px; }
  /* Row height follows the editor font size: main.js measures it, rounds to
   * whole pixels, and publishes --sm-row-h, which this rule consumes — CSS
   * and the virtualization math must never disagree (drift = jumping). */
  .pane-log .row-line { height: var(--sm-row-h, 20px); line-height: var(--sm-row-h, 20px); white-space: pre; width: max-content; min-width: 100%; }
  .pane-hint { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); pointer-events: none; user-select: none; }
  /* Highlight overview strips: tag marks (right) and find ticks (left of them). */
  .log-marks { display: none; position: absolute; top: 4px; bottom: 4px; right: 13px; width: 4px; z-index: 5; cursor: pointer; }
  .log-marks .mark { position: absolute; left: 0; width: 100%; min-height: 2px; border-radius: 1px; opacity: 0.85; }
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
  .fbtn { width: 24px; min-width: 24px; height: 24px; padding: 0; font-size: 13px; border-radius: 3px; flex: none; }
  .fbtn.on { background: var(--vscode-inputOption-activeBackground, rgba(255, 255, 255, 0.15)); color: var(--vscode-inputOption-activeForeground, var(--vscode-focusBorder)); outline: 1px solid var(--vscode-inputOption-activeBorder, transparent); }
  .find-count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 64px; text-align: center; user-select: none; }
  .find-count.error { color: var(--vscode-errorForeground, #f14c4c); }
  ::highlight(sm-find) { background-color: rgba(236, 200, 96, 0.45); }
  ::highlight(sm-find-cur) { background-color: rgba(255, 140, 0, 0.65); color: #ffffff; }
  /* Port-local send bar, collapsed by default. */
  .pane-send { display: none; gap: 6px; align-items: center; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); flex: none; }
  .pane-send input { flex: 1; height: 24px; box-sizing: border-box; font-size: 13px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--sm-radius); outline: none;
    font-family: var(--vscode-editor-font-family, monospace); padding: 0 8px; }
  .pane-send input:focus { border-color: var(--vscode-focusBorder); }
  .pane-send button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: var(--sm-radius); padding: 0 12px; height: 24px; flex: none; }
  .pane-send button:disabled { opacity: 0.4; }
</style>
</head>
<body>
  <div id="panes"></div>
  <datalist id="baud-options"></datalist>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
