# Changelog

All notable changes to Serial Monitor (OSS) are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-03

### Added

- **The start bar carries the full serial config** — the same baud
  quick-pick (▾ recents + presets) and collapsible params (☰ data bits /
  parity / stop bits / line ending) that pane bars have, built from one
  shared builder so the two surfaces cannot drift. Chosen values, including
  line ending, flow into the connect.

### Changed

- **Send with line ending `None`** no longer falls back to `LF` (UI form
  `None` vs host form `none` is now normalized case-insensitively).
- **Port picker is a live edit** — it stays usable while connected and
  picking another port moves the pane through the replace flow (only the
  connecting state locks it, visibly); the picker's own refresh no longer
  resets a pick that is still in the list.
- **Tags and filter mode are per pane (ADR-0006)** — a tag created from a
  pane belongs to that pane: its chips, highlighting, find, and include/
  exclude filter apply there alone. Each port's tag set persists separately
  (`serialMonitor.portTags`, keyed from session creation so stopped-pane
  edits are not lost) and survives close/reopen; the global
  `serialMonitor.tags` setting is no longer used.

### Fixed

- Port pickers survive their own refresh round-trip: an unchanged list is
  not rebuilt mid-pick (the popup stays open), and the start bar keeps a
  pick that still exists in the refreshed list.

## [0.2.0] - 2026-11-02

### Added

- **Split-view multi-monitor** — one session per pane: several ports stream
  side by side, each with an independent buffer, Follow/Lock state,
  log-to-file, and send bar. Draggable divider between panes (ADR-0005).
- **Per-pane serial config** embedded in each pane bar (port, baud, data
  bits, parity, stop bits, line ending). Port locked while connected; baud /
  data bits / parity / stop bits edits **live-reconnect** the session in
  place, keeping the pane, its buffer, and its log file.
- **Open log files** — saved `.log`/`.txt` files open as read-only panes with
  the full find / filter / export tooling (new `Serial Monitor: Open Log
  File...` command and 📂 button).
- **Find per pane** (Ctrl+F, F3 / Shift+F3) — match-case, whole word, and
  regex modes with an occurrence counter, prev/next navigation, text-level
  highlighting through the CSS Custom Highlight API, and a find-tick overview
  strip.
- **Doubled global controls** — every pane bar carries its own copy of the
  global actions (add monitor, refresh, filter, timestamps, log directory,
  open file, tags, manage) and a per-pane status readout; nothing re-parents
  on focus. Filter control is a funnel (inline SVG).
- **Iconized toolbar** — filter funnel, broom→trash clear, ⏱ timestamps
  toggle, ⚪/🔴 log-to-file, ▾ baud quick-pick per pane (recents first).
- Connection hints: empty-pane state hints (Connecting… / Waiting for data… /
  Stopped), iconized per-pane status (✔ / ⌛ / ○) with transient messages.
- Public API: several `startMonitoringPort` sessions may run at once; the
  `lineEnding` push is session-tagged.

### Changed

- Console text uses the Microsoft-terminal gray palette (#cccccc dark /
  #3b3b3b light) for both themes.
- Receive timestamps default to **on**.
- The clear action is the trash-can icon; the tag-filter is a funnel.
- Wire protocol and find/window-math/status cores are shared, typed modules
  (`shared/protocol.ts`, `webview/findCore.ts`, `webview/windowMath.ts`,
  `shared/lineText.ts`).

### Fixed

- Scroll position drift that made both panes' scrollbars jump and broke find
  jumps (integer row-height contract between CSS and the renderer).
- Silent wiring drops from the pane refactor (tag button, spacers shared
  across panes).
- A failed pane restart can no longer strand the replace request; the old
  pane survives.
- Empty-state row pinned to the top; no phantom horizontal scrollbar.

## [0.1.0] - 2026-10-31

### Added

- Initial MVP: base monitor (port picker, serial params, send bar, capped
  ring buffer, virtualized console), per-tag highlight/filter with the
  three-state global filter, Scroll Lock, per-session log directory and
  one-shot export, per-line receive timestamps, vendored public API
  (`startMonitoringPort`, `Port.onClosed`, version negotiation), com0com
  smoke tooling, and the integration suite.
